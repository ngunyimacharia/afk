import path from 'node:path';
import { ActiveRunControlPlane } from './active-run-control-plane.js';
import { ActiveRunEventStream } from './active-run-event-stream.js';
import { CompositeAgentExecutionProvider } from './agent-execution-provider.js';
import { mergeCompletedFeaturesToBase } from './feature-base-merge.js';
import { GitFeatureLockProvider, GitFeatureMergeBackProvider } from './git-feature-providers.js';
import {
  createHarnessAgentExecutionProvider,
  createHarnessExecutor,
  type SelectableHarnessId,
} from './harness-registry.js';
import { MergeBackCoordinator } from './merge-back-coordinator.js';
import { classifyProgressEvent, classifyRunOutcome, NotificationPolicy } from './notification-policy.js';
import { PermissionCoordinator } from './permission-coordinator.js';
import { RuntimeStore } from './runtime-store.js';
import { Scheduler } from './scheduler.js';
import { ScratchWorktreeService } from './scratch-worktree-service.js';
import { SingleTicketRunner } from './single-ticket-runner.js';
import type { AgentExecutionProgressEvent, BudgetPolicy, LaunchPlan } from './types.js';

export interface DaemonLaunchContext {
  repoRoot: string;
  runId: string;
  plan: LaunchPlan;
  harness: SelectableHarnessId;
  reviewerHarness: SelectableHarnessId;
  concurrency: number;
  budgets?: Partial<BudgetPolicy>;
  mergeBackToBase?: boolean;
  baseBranch?: string;
}

export async function runDaemon(context: DaemonLaunchContext): Promise<void> {
  const { repoRoot, runId, plan, harness, reviewerHarness, concurrency, budgets, mergeBackToBase, baseBranch } =
    context;

  const activeRunControlPlane = new ActiveRunControlPlane({ repoRoot });
  activeRunControlPlane.transition(runId, 'running');

  const eventStream = new ActiveRunEventStream(repoRoot, runId);
  const runtimeStore = new RuntimeStore({ repoRoot });

  const permissionCoordinator = new PermissionCoordinator({
    ticketLabel: plan.tickets[0]?.label,
    autoApprove: true,
  });

  const implementationExecutor = createHarnessExecutor(harness);
  const reviewerExecutor = createHarnessExecutor(reviewerHarness);

  const executionProvider = createHarnessAgentExecutionProvider(harness, implementationExecutor, permissionCoordinator);
  const reviewerProvider = createHarnessAgentExecutionProvider(reviewerHarness, reviewerExecutor, permissionCoordinator);

  const runner = new SingleTicketRunner(
    runtimeStore,
    new CompositeAgentExecutionProvider(executionProvider, reviewerProvider),
    budgets,
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
    ) => {
      const featureCheckout = checkoutsByFeature[feature];
      if (!featureCheckout) return;
      const tickets = issueNames.map((issueName) => {
        const ticketRecord = plan.tickets.find((t) => t.feature === feature && t.issueName === issueName);
        const ticketSnapshot = plan.snapshots?.[`${feature}/${issueName}`];
        return {
          feature,
          issueName,
          branchName: `afk/${feature}/${issueName}`,
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

  const heartbeatInterval = setInterval(() => {
    activeRunControlPlane.heartbeat(runId);
  }, 30_000);

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

    if (
      mergeBackToBase &&
      baseBranch &&
      schedulerResult.ticketResults.every((result) => result.outcome === 'completed')
    ) {
      await mergeCompletedFeaturesToBase({
        repoRoot,
        baseBranch,
        features: Object.keys(checkoutsByFeature),
        checkoutsByFeature,
        coordinator: mergeBackCoordinator,
        model: plan.model,
        reviewerModel: plan.reviewerModel,
        reviewerPrompt: plan.reviewerPrompt,
        onProgress,
      });
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
