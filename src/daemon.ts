import path from 'node:path';
import { ActiveRunControlPlane } from './active-run-control-plane.js';
import { ActiveRunEventStream } from './active-run-event-stream.js';
import { CompositeAgentExecutionProvider } from './agent-execution-provider.js';
import { featuresWithAllTicketsCompleted, mergeCompletedFeaturesToBase } from './feature-base-merge.js';
import { createPullRequestsForCompletedFeatures } from './feature-pr-creation.js';
import { GitFeatureLockProvider, GitFeatureMergeBackProvider } from './git-feature-providers.js';
import type { SelectableHarnessId } from './harness-registry.js';
import { LinearGraphqlClient, resolveLinearConfig } from './linear.js';
import { isMergeInProgress, MergeBackCoordinator } from './merge-back-coordinator.js';
import { classifyProgressEvent, classifyRunOutcome, NotificationPolicy } from './notification-policy.js';
import { loadAfkProjectConfig } from './project-config.js';
import { RuntimeStore } from './runtime-store.js';
import { SandcastleAgentExecutionProvider } from './sandcastle-agent-execution-provider.js';
import { Scheduler } from './scheduler.js';
import { ScratchWorktreeService } from './scratch-worktree-service.js';
import { SingleTicketRunner } from './single-ticket-runner.js';
import type { AgentExecutionProgressEvent, BudgetPolicy, FeatureCompletionAction, LaunchPlan } from './types.js';

export interface DaemonLaunchContext {
  repoRoot: string;
  runId: string;
  plan: LaunchPlan;
  harness: SelectableHarnessId;
  reviewerHarness: SelectableHarnessId;
  concurrency: number;
  budgets?: Partial<BudgetPolicy>;
  mergeBackToBase?: boolean;
  featureCompletionAction?: FeatureCompletionAction;
  baseBranch?: string;
}

export async function runDaemon(context: DaemonLaunchContext): Promise<void> {
  const { repoRoot, runId, plan, concurrency, budgets, mergeBackToBase, featureCompletionAction, baseBranch } = context;
  const resolvedCompletionAction: FeatureCompletionAction =
    featureCompletionAction ?? (mergeBackToBase === false ? 'create-pr' : 'merge-to-base');

  const activeRunControlPlane = new ActiveRunControlPlane({ repoRoot });
  activeRunControlPlane.transition(runId, 'running');

  const heartbeatInterval = setInterval(() => {
    activeRunControlPlane.heartbeat(runId);
  }, 30_000);

  const eventStream = new ActiveRunEventStream(repoRoot, runId);
  const runtimeStore = new RuntimeStore({ repoRoot });

  const executionProvider = new SandcastleAgentExecutionProvider();
  const reviewerProvider = executionProvider;
  const linearSyncer = await resolveDaemonLinearSyncer(repoRoot);

  const runner = new SingleTicketRunner(
    runtimeStore,
    new CompositeAgentExecutionProvider(executionProvider, reviewerProvider),
    budgets,
    linearSyncer,
  );

  const notificationPolicy = new NotificationPolicy();

  const onProgress = (event: AgentExecutionProgressEvent) => {
    eventStream.appendProgress(event);
    const policyEvent = classifyProgressEvent(event);
    if (policyEvent) {
      notificationPolicy.maybeNotify(policyEvent);
    }
  };

  const mergeBackCoordinator = new MergeBackCoordinator({
    agentExecutionProvider: new CompositeAgentExecutionProvider(executionProvider, reviewerProvider),
    runtimeStore,
  });

  const checkoutsByFeature = plan.checkouts ?? {};
  const gitMergeBackProvider = new GitFeatureMergeBackProvider(repoRoot, checkoutsByFeature);
  const gitLockProvider = new GitFeatureLockProvider(checkoutsByFeature);

  for (const [feature, checkout] of Object.entries(checkoutsByFeature)) {
    if (!isMergeInProgress(checkout.worktreePath)) continue;

    onProgress({
      ticketLabel: '__run__',
      message: `Feature worktree ${checkout.effectiveWorktreeName} has unresolved merge conflicts; starting conflict resolution`,
    });

    const runLevelOnProgress = (event: AgentExecutionProgressEvent) => {
      onProgress({ ...event, ticketLabel: '__run__' });
    };

    const conflictResult = await mergeBackCoordinator.resolveFeatureWorktreeConflicts({
      repoRoot,
      feature,
      featureWorktreePath: checkout.worktreePath,
      featureBranchName: checkout.effectiveBranchName,
      model: plan.model,
      reviewerModel: plan.reviewerModel,
      reviewerPrompt: plan.reviewerPrompt,
      onProgress: runLevelOnProgress,
    });

    if (!conflictResult.success) {
      const reason = conflictResult.reason ?? 'Unresolved merge conflicts could not be resolved';
      onProgress({
        ticketLabel: '__run__',
        message: `run handoff: ${reason}`,
        kind: 'failure',
      });
      return;
    }

    onProgress({
      ticketLabel: '__run__',
      message: `Merge conflicts resolved for ${checkout.effectiveWorktreeName}`,
    });
  }

  let currentRunState: 'running' | 'paused' = 'running';

  const applyPause = () => {
    if (currentRunState === 'paused') return;
    currentRunState = 'paused';
    scheduler.pause();
    activeRunControlPlane.transition(runId, 'paused');
    const event: AgentExecutionProgressEvent = { ticketLabel: '__run__', message: 'run paused' };
    eventStream.appendProgress(event);
  };

  const applyResume = () => {
    if (currentRunState === 'running') return;
    currentRunState = 'running';
    scheduler.resume();
    activeRunControlPlane.transition(runId, 'running');
    const event: AgentExecutionProgressEvent = { ticketLabel: '__run__', message: 'run resumed' };
    eventStream.appendProgress(event);
  };

  const scheduler = new Scheduler({
    runner,
    scratchWorktreeService: new ScratchWorktreeService(),
    concurrencyLimit: concurrency,
    featureMergeBackProvider: {
      isWaveMerged: (feature: string, wave: number, issueNames: string[]) =>
        mergeBackCoordinator.isWaveMerged(feature, wave, issueNames) ||
        gitMergeBackProvider.isWaveMerged(feature, wave, issueNames),
    },
    featureLockProvider: {
      isLocked: (feature: string) => gitLockProvider.isLocked(feature) || mergeBackCoordinator.isLocked(feature),
    },
    onWaveComplete: async (
      feature: string,
      wave: number,
      issueNames: string[],
      issueWorktreePaths: Record<string, string>,
      issueCheckouts,
    ) => {
      const featureCheckout = checkoutsByFeature[feature];
      if (!featureCheckout) return;
      const tickets = issueNames.map((issueName) => {
        const ticketRecord = plan.tickets.find((t) => t.feature === feature && t.issueName === issueName);
        const ticketSnapshot = plan.snapshots?.[`${feature}/${issueName}`];
        return {
          feature,
          issueName,
          branchName:
            issueCheckouts[issueName]?.effectiveBranchName ??
            ticketSnapshot?.branchName ??
            `afk/${feature}/${issueName}`,
          worktreePath: issueWorktreePaths[issueName] ?? ticketSnapshot?.worktreePath ?? featureCheckout.worktreePath,
          dependsOn: ticketRecord?.dependsOn,
          metadataPath: path.join(
            repoRoot,
            '.scratch',
            '.opencode-afk-logs',
            'runtime-metadata',
            `${feature}-${issueName}.json`,
          ),
          logPath: path.join(repoRoot, '.scratch', '.opencode-afk-logs', `${feature}-${issueName}.log`),
        };
      });
      await mergeBackCoordinator.mergeWave({
        repoRoot,
        feature,
        featureWorktreePath: featureCheckout.worktreePath,
        featureBranchName: featureCheckout.effectiveBranchName,
        wave,
        tickets,
        model: plan.model,
        reviewerModel: plan.reviewerModel,
        reviewerPrompt: plan.reviewerPrompt,
        onProgress,
      });
    },
  });

  let commandPollInterval: ReturnType<typeof setInterval> | null = null;
  let lastCommandOffset = 0;
  const killController = new AbortController();
  let commandOffset = 0;
  const killPollInterval = setInterval(() => {
    if (killController.signal.aborted) return;
    const { commands, nextOffset } = eventStream.readCommandsFromOffset(commandOffset);
    commandOffset = nextOffset;
    if (commands.includes('kill')) {
      killController.abort();
    }
  }, 500);

  try {
    commandPollInterval = setInterval(() => {
      const { commands, nextOffset } = activeRunControlPlane.readCommands(runId, lastCommandOffset);
      lastCommandOffset = nextOffset;
      for (const command of commands) {
        if (command.type === 'pause') applyPause();
        else if (command.type === 'resume') applyResume();
      }
    }, 250);

    const schedulerResult = await scheduler.launch(plan, {
      onProgress,
      runId,
      signal: killController.signal,
    });

    if (killController.signal.aborted) {
      activeRunControlPlane.transition(runId, 'killing');
      return;
    }

    if (baseBranch && resolvedCompletionAction === 'merge-to-base') {
      const eligibleFeatures = featuresWithAllTicketsCompleted(
        schedulerResult.ticketResults,
        Object.keys(checkoutsByFeature),
      );
      if (eligibleFeatures.length > 0) {
        await mergeCompletedFeaturesToBase({
          repoRoot,
          baseBranch,
          features: eligibleFeatures,
          checkoutsByFeature,
          coordinator: mergeBackCoordinator,
          model: plan.model,
          reviewerModel: plan.reviewerModel,
          reviewerPrompt: plan.reviewerPrompt,
          onProgress,
        });
      }
    } else if (resolvedCompletionAction === 'create-pr') {
      const eligibleFeatures = featuresWithAllTicketsCompleted(
        schedulerResult.ticketResults,
        Object.keys(checkoutsByFeature),
      );
      if (eligibleFeatures.length > 0) {
        const prResults = await createPullRequestsForCompletedFeatures({
          repoRoot,
          baseBranch: baseBranch ?? plan.checkout.defaultBranchName,
          features: eligibleFeatures,
          checkoutsByFeature,
          agentExecutionProvider: new CompositeAgentExecutionProvider(executionProvider, reviewerProvider),
          model: plan.model,
          ticketResults: schedulerResult.ticketResults,
          onProgress,
        });
        for (const result of prResults) {
          onProgress({
            ticketLabel: '__run__',
            message:
              result.success && result.prUrl
                ? `pull request created for ${result.feature}: ${result.prUrl}`
                : `pull request creation failed for ${result.feature}: ${result.reason ?? 'unknown error'}`,
            kind: result.success ? 'message' : 'failure',
          });
        }
      }
    }

    const runOutcomeEvent = classifyRunOutcome({
      runId,
      ticketResults: schedulerResult.ticketResults.map((r) => ({
        ticketLabel: r.ticket.label,
        outcome: r.outcome,
      })),
    });
    if (runOutcomeEvent) {
      notificationPolicy.maybeNotify(runOutcomeEvent);
    }
  } finally {
    if (commandPollInterval) clearInterval(commandPollInterval);
    if (killPollInterval) clearInterval(killPollInterval);
    clearInterval(heartbeatInterval);
    activeRunControlPlane.clear(runId);
  }
}

async function resolveDaemonLinearSyncer(repoRoot: string) {
  const projectConfig = loadAfkProjectConfig(repoRoot).config;
  if (!projectConfig?.linear) return undefined;
  const client = new LinearGraphqlClient(projectConfig.linear.apiKey ?? '');
  const resolvedConfig = await resolveLinearConfig({ config: projectConfig.linear, env: process.env, client });
  return { resolvedConfig, client };
}
