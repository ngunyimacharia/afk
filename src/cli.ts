import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { ActiveRunControlPlane } from './active-run-control-plane.js';
import { ActiveRunEventStream } from './active-run-event-stream.js';
import {
  type AgentExecutionProvider,
  ClaudeKimiAgentExecutionProvider,
  CompositeAgentExecutionProvider,
  OpenCodeAgentExecutionProvider,
} from './agent-execution-provider.js';
import { ClaudeCodeSessionExecutor, discoverClaudeKimiModels } from './claude-code.js';
import { CleanupExecutor, CleanupPlanner } from './cleanup.js';
import { type DaemonLaunchContext, runDaemon } from './daemon.js';
import {
  logResolvedExecutables,
  RequiredExecutableError,
  resolveExecutable,
  resolveExecutables,
} from './executable-resolution.js';
import { type FeatureBaseMergeResult, mergeCompletedFeaturesToBase } from './feature-base-merge.js';
import { buildFeatureExecutionGraph, type FeatureExecutionGraph } from './feature-execution-graph.js';
import { FeatureExecutionRefreshService } from './feature-execution-refresh.js';
import { GitFeatureLockProvider, GitFeatureMergeBackProvider } from './git-feature-providers.js';
import { isInteractiveLaunchAllowed, type PromptIO, runInteractiveLaunchWizard } from './interactive-launch.js';
import { buildLaunchPlan } from './launch-context-builder.js';
import {
  discoverLinearFeatures,
  LinearGraphqlClient,
  type LinearParentFeature,
  resolveLinearConfig,
} from './linear.js';
import { createLiveRunView } from './live-run-view.js';
import { MergeBackCoordinator } from './merge-back-coordinator.js';
import { classifyProgressEvent, classifyRunOutcome, NotificationPolicy } from './notification-policy.js';
import type { OpenCodeSessionExecutor } from './opencode.js';
import { discoverOpenCodeModels, SDKOpenCodeSessionExecutor } from './opencode.js';
import { formatDuration } from './opentui-dashboard.js';
import { OpenTUINotificationAdapter, type OpenTUIRenderer } from './opentui-notification-adapter.js';
import type { PermissionDecisionHistoryEntry } from './permission-coordinator.js';
import { PermissionCoordinator } from './permission-coordinator.js';
import { loadAfkProjectConfig } from './project-config.js';
import { classifyProviderFailure, classifyProviderFailureFromSource } from './provider-failure.js';
import { RuntimeStore } from './runtime-store.js';
import { Scheduler, type SchedulerTicketResult } from './scheduler.js';
import { ScratchWorktreeService } from './scratch-worktree-service.js';
import { SingleTicketRunner } from './single-ticket-runner.js';
import { SummaryReporter } from './summary-reporter.js';
import { runSync } from './sync/runner.js';
import { TicketRepository } from './ticket-repository.js';
import type { LaunchModel, TicketRecord } from './types.js';
import {
  orderSelectedFeaturesByWaves,
  refreshWorkspaceExecutionGraph,
  type WorkspaceExecutionGraph,
} from './workspace-execution-graph.js';
import { runGit, WorktreePreparationService, WorktreeReadinessBlockedError } from './worktree-preparation-service.js';

export function formatLinearDiscoveryLines(features: LinearParentFeature[]): string[] {
  const lines = features
    .filter((feature) => feature.workItems.length > 0)
    .flatMap((feature) => [
      `- ${feature.featureSlug}: ${feature.key} - ${feature.title} (${feature.workItems.length} labeled subissues)`,
      ...feature.workItems.map((item) => `  - ${item.key}: ${item.title}`),
    ]);
  return lines.length ? ['Linear discovery found labeled subissues:', ...lines] : [];
}

function linearIssueSlug(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function linearTicketContent(feature: LinearParentFeature, item: LinearParentFeature['workItems'][number]): string {
  const body = item.body.trim();
  return [
    `# ${item.title}`,
    '',
    `Linear issue: ${item.url}`,
    `Linear parent: ${feature.key} - ${feature.title}`,
    `Linear parent URL: ${feature.url}`,
    '',
    body || '_No Linear description provided._',
    '',
  ].join('\n');
}

export function linearFeaturesToTicketRecords(features: LinearParentFeature[]): TicketRecord[] {
  return features.flatMap((feature) =>
    feature.workItems.flatMap((item) => {
      const issueName = linearIssueSlug(item.key);
      if (!issueName) return [];
      return [
        {
          path: `linear://${item.key}`,
          feature: feature.featureSlug,
          issueName,
          label: `${feature.featureSlug}/${issueName}`,
          status: 'ready-for-agent',
          executorAfk: true,
          dependsOn: [],
          source: 'linear' as const,
          content: linearTicketContent(feature, item),
        },
      ];
    }),
  );
}

function isLinearTicket(ticket: TicketRecord): boolean {
  return ticket.source === 'linear';
}

function buildLinearWorkspaceGraph(
  selectedFeatures: string[],
  linearFeatures: Set<string>,
  localGraph: WorkspaceExecutionGraph | null,
  concurrency: number,
): WorkspaceExecutionGraph {
  const localWaves = localGraph?.featureWaves ?? [];
  const localWaveFeatures = new Set(localWaves.flat());
  const linearWaves = selectedFeatures.filter(
    (feature) => linearFeatures.has(feature) && !localWaveFeatures.has(feature),
  );
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    selectedFeatures,
    concurrency,
    featureWaves: [...localWaves, ...(linearWaves.length ? [linearWaves] : [])],
    features: {
      ...(localGraph?.features ?? {}),
      ...Object.fromEntries(
        linearWaves.map((feature) => [
          feature,
          {
            state: 'ready' as const,
            dependsOnFeatures: [],
            blockedByFeatures: [],
            stackParent: null,
            blockingIssues: [],
          },
        ]),
      ),
    },
  };
}

function commandArg(): string | undefined {
  const knownCommands = new Set([
    'summary',
    'cleanup',
    'afk-summary',
    'afk-cleanup',
    'sync',
    'tui',
    'stop',
    'status',
    '__daemon',
  ]);
  const arg1 = process.argv[1];
  const arg2 = process.argv[2];
  if (arg1 && knownCommands.has(arg1)) {
    if (arg1 === 'summary' || arg1 === 'afk-summary') return 'afk-summary';
    if (arg1 === 'cleanup' || arg1 === 'afk-cleanup') return 'afk-cleanup';
    return arg1;
  }
  if (arg2 === 'summary' || arg2 === 'afk-summary') return 'afk-summary';
  if (arg2 === 'cleanup' || arg2 === 'afk-cleanup') return 'afk-cleanup';
  return arg2;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

export interface SpawnDaemonHandle {
  pid: number | undefined;
  unref: () => void;
  on: (event: 'exit' | 'error', callback: (code?: number | null, signal?: NodeJS.Signals | null) => void) => void;
}

export async function runAfk(
  repoRoot = process.cwd(),
  runtime: {
    io?: PromptIO;
    env?: NodeJS.ProcessEnv;
    spawnDaemon?: (context: DaemonLaunchContext) => SpawnDaemonHandle;
    inlineLaunch?: boolean;
    stopTimeoutMs?: number;
    stopPollIntervalMs?: number;
  } = {},
): Promise<{ code: number; message: string }> {
  const io = runtime.io ?? { stdin: process.stdin, stdout: process.stdout };
  const env = runtime.env ?? process.env;
  const command = commandArg();

  try {
    const resolvedExecutables = resolveExecutables(['git', 'which']);
    if (hasFlag('--verbose') || hasFlag('-v') || env.AFK_DEBUG) {
      logResolvedExecutables(resolvedExecutables);
    }
  } catch (error) {
    if (error instanceof RequiredExecutableError) {
      return { code: 1, message: error.message };
    }
    throw error;
  }

  if (command === 'afk-summary') {
    const reporter = new SummaryReporter({ repoRoot });
    const report = await reporter.summarize();
    return { code: 0, message: report.message };
  }
  if (command === 'afk-cleanup') {
    const isDryRun = hasFlag('--dry-run');
    const planner = new CleanupPlanner({ repoRoot });
    const plan = planner.buildPlan();
    const logTargets = plan.terminalTargets
      .flatMap((target) => [target.logPath, target.metadataPath, target.doneSentinelPath, target.failedSentinelPath])
      .filter(Boolean) as string[];
    if (plan.workspaceExecutionPath) logTargets.push(plan.workspaceExecutionPath);
    const dryRun = [
      'AFK Cleanup Plan',
      '',
      'Terminal tickets to delete',
      ...(plan.terminalTargets.length ? plan.terminalTargets.map((target) => `- ${target.issuePath}`) : ['- none']),
      '',
      'Matching logs / metadata to delete',
      ...(logTargets.length ? logTargets.map((filePath) => `- ${filePath}`) : ['- none']),
      '',
      'Pending failed post-merge cleanup retries',
      ...(plan.pendingPostMergeCleanupTargets.length
        ? plan.pendingPostMergeCleanupTargets.map(
            (item) =>
              `- ${item.feature}/${item.issueName} branch=${item.branchName} worktree=${item.worktreePath} (${item.warning ?? item.error ?? 'pending retry'})`,
          )
        : ['- none']),
      '',
      'Preserved tickets',
      ...(plan.preservedIssues.length ? plan.preservedIssues.map((issuePath) => `- ${issuePath}`) : ['- none']),
      '',
      'Preserved artifacts',
      ...(plan.preservedArtifacts.length ? plan.preservedArtifacts.map((artifact) => `- ${artifact}`) : ['- none']),
      '',
      'Feature directories to delete',
      ...(plan.featureDirectoriesToDelete.length
        ? plan.featureDirectoriesToDelete.map((featureDir) => `- ${featureDir}`)
        : ['- none']),
      '',
      isDryRun ? 'Dry run only. No files were deleted.' : 'Cleanup executes immediately (no confirmation required).',
    ].join('\n');
    if (isDryRun) return { code: 0, message: dryRun };
    const executor = new CleanupExecutor();
    const result = executor.execute(plan, repoRoot);
    const retryResults = [
      'Post-merge cleanup retry results',
      ...(result.postMergeCleanupResults.length
        ? result.postMergeCleanupResults.map((item) =>
            item.success
              ? `- ${item.feature}/${item.issueName}: success`
              : `- ${item.feature}/${item.issueName}: failed (${item.warning ?? item.error ?? 'unknown error'})`,
          )
        : ['- none']),
    ].join('\n');
    return {
      code: 0,
      message: `${dryRun}\n\n${retryResults}\n\nExecuted:\n${result.deleted.map((item) => `- ${item}`).join('\n') || '- none'}`,
    };
  }
  if (command === 'sync') return runSync();
  if (command === 'tui') {
    const activeRunControlPlane = new ActiveRunControlPlane({ repoRoot });
    const activeRun = activeRunControlPlane.read();
    if (!activeRun || !activeRunControlPlane.isHealthy(activeRun)) {
      return { code: 1, message: 'No active run' };
    }
    return attachToActiveRun(repoRoot, io, activeRun.runId, activeRunControlPlane);
  }
  if (command === 'stop') {
    const activeRunControlPlane = new ActiveRunControlPlane({ repoRoot });
    const activeRun = activeRunControlPlane.read();
    if (!activeRun || !activeRunControlPlane.isHealthy(activeRun)) {
      return { code: 1, message: 'No active AFK run' };
    }
    const eventStream = new ActiveRunEventStream(repoRoot, activeRun.runId);
    eventStream.appendCommand('kill');
    const stopTimeoutMs = runtime.stopTimeoutMs ?? 30_000;
    const stopPollIntervalMs = runtime.stopPollIntervalMs ?? 500;
    const start = Date.now();
    while (Date.now() - start < stopTimeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, stopPollIntervalMs));
      const current = activeRunControlPlane.read();
      if (!current || !activeRunControlPlane.isHealthy(current)) {
        return { code: 0, message: `Stopped AFK run ${activeRun.runId}` };
      }
    }
    return { code: 1, message: `Timeout: AFK run ${activeRun.runId} did not stop within ${stopTimeoutMs / 1000}s` };
  }
  if (command === 'status') {
    const activeRunControlPlane = new ActiveRunControlPlane({ repoRoot });
    const activeRun = activeRunControlPlane.read();
    if (!activeRun || !activeRunControlPlane.isHealthy(activeRun)) {
      return { code: 0, message: 'No active AFK run' };
    }
    const runMetadata = readRunMetadata(repoRoot, activeRun.runId);
    const heartbeatAgeMs = Date.now() - Date.parse(activeRun.heartbeatAt);
    const lines = [
      `Run ID:    ${activeRun.runId}`,
      `State:     ${activeRun.state}`,
      `PID:       ${activeRun.pid}`,
      `Started:   ${activeRun.startedAt}`,
      `Heartbeat: ${formatHeartbeatAge(heartbeatAgeMs)} ago`,
    ];
    if (runMetadata.modelId) lines.push(`Model:     ${runMetadata.modelId}`);
    if (runMetadata.harness) lines.push(`Harness:   ${runMetadata.harness}`);
    if (runMetadata.ticketCount > 0) lines.push(`Tickets:   ${runMetadata.ticketCount}`);
    return { code: 0, message: lines.join('\n') };
  }
  if (command === '__daemon') {
    const contextPath = process.argv[1] === '__daemon' ? process.argv[2] : process.argv[3];
    if (!contextPath) return { code: 1, message: 'Daemon context path required' };
    const context = JSON.parse(readFileSync(contextPath, 'utf8')) as DaemonLaunchContext;
    try {
      unlinkSync(contextPath);
    } catch {
      // Best-effort cleanup of context file
    }
    await runDaemon(context);
    return { code: 0, message: '' };
  }
  const runtimeStore = new RuntimeStore({ repoRoot });
  const launchPreferences = runtimeStore.readLaunchPreferences();
  const projectConfig = loadAfkProjectConfig(repoRoot);
  if (!projectConfig.config) return { code: 1, message: projectConfig.errors.join('\n') };
  const interactivity = isInteractiveLaunchAllowed(io, env);
  if (!interactivity.ok)
    return { code: 1, message: interactivity.reason ?? 'AFK launch requires an interactive terminal.' };
  let runId: string = randomUUID();
  const activeRunControlPlane = new ActiveRunControlPlane({ repoRoot });
  const activeRun = activeRunControlPlane.acquireOrAttach(runId);
  if (activeRun.action === 'attached') {
    return attachToActiveRun(repoRoot, io, activeRun.record.runId, activeRunControlPlane);
  }

  // Use the runId from the control plane record (recovered runs reuse the old runId)
  runId = activeRun.record.runId;

  const isRecoveredRun = activeRun.action === 'recovered';
  if (isRecoveredRun) {
    const recoveryEvent: import('./types.js').AgentExecutionProgressEvent = {
      ticketLabel: '__run__',
      message: activeRun.recoveryMessage,
    };
    const recoveryStream = new ActiveRunEventStream(repoRoot, runId);
    recoveryStream.appendProgress(recoveryEvent);
    io.stdout.write(`${activeRun.recoveryMessage}\n`);
  }

  const activeProjectConfig = projectConfig.config;
  activeRunControlPlane.transition(runId, 'running');
  let killPollInterval: ReturnType<typeof setInterval> | null = null;
  let clearOnExit = true;
  try {
    const repository = new TicketRepository(repoRoot);
    let allTickets: TicketRecord[];
    try {
      allTickets = repository.discoverTickets();
    } catch (error) {
      return { code: 1, message: formatTicketMetadataError(error) };
    }
    let linearTickets: TicketRecord[] = [];
    if (activeProjectConfig.linear) {
      try {
        const client = new LinearGraphqlClient(env.LINEAR_API_KEY ?? '');
        const resolvedConfig = await resolveLinearConfig({ config: activeProjectConfig.linear, env, client });
        const linearFeatures = await discoverLinearFeatures({ resolvedConfig, client });
        const discoveryLines = formatLinearDiscoveryLines(linearFeatures);
        if (discoveryLines.length) io.stdout.write(`${discoveryLines.join('\n')}\n`);
        linearTickets = linearFeaturesToTicketRecords(linearFeatures);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown Linear discovery error';
        return { code: 1, message: `Linear ticket discovery failed.\nReason: ${reason}` };
      }
    }
    const localTickets = allTickets.filter((ticket) => repository.isEligible(ticket));
    const tickets = [...localTickets, ...linearTickets];
    const launchTickets = [...allTickets, ...linearTickets];
    if (!tickets.length) return { code: 0, message: 'No pending AFK tickets found' };
    const worktreePreparationService = new WorktreePreparationService();
    let model: LaunchModel | undefined;
    let reviewerModel: LaunchModel | undefined;
    let reviewerPrompt: { id: string; label: string; path: string } | undefined;
    let selectedTickets: TicketRecord[] = [];
    let concurrency = 3;
    let mergeBackToBase = false;
    let harness: 'OpenCode' | 'Claude-Kimi' = 'OpenCode';
    let reviewerHarness: 'OpenCode' | 'Claude-Kimi' = 'OpenCode';

    const harnessModelCache: Record<string, LaunchModel[]> = {};
    const availableHarnesses: string[] = [];
    try {
      const opencodeModels = await discoverOpenCodeModels();
      if (opencodeModels.length > 0) {
        availableHarnesses.push('OpenCode');
        harnessModelCache.OpenCode = opencodeModels;
      }
    } catch {
      // OpenCode not available
    }
    try {
      const claudeKimiModels = await discoverClaudeKimiModels();
      if (claudeKimiModels.length > 0) {
        availableHarnesses.push('Claude-Kimi');
        harnessModelCache['Claude-Kimi'] = claudeKimiModels;
      }
    } catch {
      // Claude Kimi not available
    }

    if (availableHarnesses.length === 0) {
      return {
        code: 0,
        message: 'No harnesses available. Install and configure OpenCode or Claude.',
      };
    }

    try {
      const wizard = await runInteractiveLaunchWizard({
        io,
        repoRoot,
        availableHarnesses,
        discoverModels: async (selectedHarness) => {
          if (harnessModelCache[selectedHarness]) return harnessModelCache[selectedHarness];
          if (selectedHarness === 'Claude-Kimi') return discoverClaudeKimiModels();
          return discoverOpenCodeModels();
        },
        tickets,
        preferences: launchPreferences,
      });
      if (wizard.cancelled) return { code: 0, message: 'Launch cancelled' };
      harness = wizard.harness ?? 'OpenCode';
      reviewerHarness = wizard.reviewerHarness ?? harness;
      model = wizard.model;
      reviewerModel = wizard.reviewerModel;
      reviewerPrompt = wizard.reviewerPrompt;
      selectedTickets = wizard.tickets ?? [];
      concurrency = wizard.concurrency ?? concurrency;
      mergeBackToBase = wizard.mergeBackToBase ?? false;
      runtimeStore.writeLaunchPreferences({
        harness: wizard.harness,
        modelId: model?.id,
        reviewerHarness: wizard.reviewerHarness,
        reviewerModelId: reviewerModel?.id,
        concurrency,
        mergeBackToBase,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown model discovery error';
      return {
        code: 0,
        message: `Model discovery failed. Configure the selected provider and retry.\nReason: ${reason}`,
      };
    }
    if (!model) return { code: 0, message: 'Launch cancelled' };
    if (!reviewerModel || !reviewerPrompt) return { code: 0, message: 'Launch cancelled' };
    if (!selectedTickets.length) return { code: 0, message: 'No tickets selected' };
    const implementationExecutor = createExecutor(harness);
    const reviewerExecutor = createExecutor(reviewerHarness);
    const preflight = await preflightSelectedModels(
      implementationExecutor,
      model,
      reviewerExecutor,
      reviewerModel,
      harness,
      reviewerHarness,
    );
    if (preflight) return { code: 1, message: preflight };
    const selectedFeatures = [...new Set(selectedTickets.map((ticket) => ticket.feature))];
    selectedTickets = expandSelectedFeaturesToAllTickets(selectedTickets, launchTickets);
    const refresh = new FeatureExecutionRefreshService(repoRoot);
    let featureGraphs: Record<string, FeatureExecutionGraph>;
    const selectedLinearFeatures = new Set(selectedTickets.filter(isLinearTicket).map((ticket) => ticket.feature));
    try {
      featureGraphs = Object.fromEntries(
        selectedFeatures.map((feature) => {
          const featureTickets = selectedTickets.filter((ticket) => ticket.feature === feature);
          if (selectedLinearFeatures.has(feature)) {
            return [feature, buildFeatureExecutionGraph(repoRoot, feature, featureTickets, false)];
          }
          return [feature, refresh.refresh(feature)];
        }),
      );
    } catch (error) {
      return { code: 1, message: formatTicketMetadataError(error) };
    }
    const orderingBlock = validateSelectedTicketDependencies(selectedTickets, launchTickets);
    if (orderingBlock) return { code: 1, message: orderingBlock };
    selectedTickets = orderSelectedTicketsByFeatureGraph(selectedTickets, featureGraphs);
    const localSelectedFeatures = selectedFeatures.filter((feature) => !selectedLinearFeatures.has(feature));
    const localWorkspaceGraph = localSelectedFeatures.length
      ? refreshWorkspaceExecutionGraph(repoRoot, localSelectedFeatures, concurrency)
      : null;
    const workspaceGraph = selectedLinearFeatures.size
      ? buildLinearWorkspaceGraph(selectedFeatures, selectedLinearFeatures, localWorkspaceGraph, concurrency)
      : (localWorkspaceGraph as WorkspaceExecutionGraph);
    const featureBlock = validateSelectedFeatureDependencies(workspaceGraph, selectedFeatures);
    if (featureBlock) return { code: 1, message: featureBlock };
    const firstTicket = selectedTickets[0];
    const baseBranch = runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const checkoutFeatures = orderSelectedFeaturesByWaves(workspaceGraph);
    let checkouts: ReturnType<WorktreePreparationService['prepare']>[];
    try {
      checkouts = checkoutFeatures.map((feature) => {
        const stackParent = workspaceGraph.features[feature]?.stackParent;
        return worktreePreparationService.prepare({
          repoRoot,
          featureSlug: feature,
          baseRef: stackParent ? stackParent : undefined,
          selectedTicketPaths: selectedTickets
            .filter((ticket) => ticket.feature === feature && !isLinearTicket(ticket))
            .map((ticket) => ticket.path),
          projectConfig: activeProjectConfig,
        });
      });
    } catch (error) {
      if (error instanceof WorktreeReadinessBlockedError)
        return { code: 1, message: `Launch blocked by worktree readiness: ${error.message}` };
      throw error;
    }
    const checkoutsByFeature = Object.fromEntries(
      checkoutFeatures.map((feature, index) => [feature, checkouts[index]]),
    );
    const checkout = checkoutsByFeature[firstTicket.feature];
    const featureDependencies = Object.fromEntries(
      selectedFeatures.map((feature) => [feature, workspaceGraph.features[feature]?.dependsOnFeatures ?? []]),
    );
    const plan = buildLaunchPlan(
      repoRoot,
      model,
      selectedTickets,
      checkout,
      { harness: reviewerHarness, model: reviewerModel, prompt: reviewerPrompt },
      checkoutsByFeature,
      featureDependencies,
      harness,
    );
    writeRunPlan(repoRoot, runId, plan.tickets);

    if (!runtime.inlineLaunch) {
      const context: DaemonLaunchContext = {
        repoRoot,
        runId,
        plan,
        harness,
        reviewerHarness,
        concurrency,
        budgets: launchPreferences.budgets,
        mergeBackToBase,
        baseBranch,
      };
      const spawnDaemon = runtime.spawnDaemon ?? defaultSpawnDaemon;
      const handle = spawnDaemon(context);
      if (!handle.pid) {
        activeRunControlPlane.clear(runId);
        return { code: 1, message: 'Failed to start background daemon. Check permissions and disk space.' };
      }
      activeRunControlPlane.updatePid(runId, handle.pid);
      handle.unref();
      clearOnExit = false;
      return {
        code: 0,
        message: [
          `Run ID: ${runId}`,
          `Selected model: ${plan.model.id}`,
          `Selected harness: ${harness}`,
          `Selected reviewer model: ${plan.reviewerModel?.id ?? 'unknown'}`,
          `Selected reviewer harness: ${reviewerHarness}`,
          `Reviewer prompt: ${plan.reviewerPrompt?.id ?? 'unknown'}`,
          `Selected tickets (${plan.tickets.length}): ${plan.tickets.map((ticket) => ticket.label).join(', ')}`,
          `Selected features (${selectedFeatures.length}): ${selectedFeatures.join(', ')}`,
          `Concurrency: ${concurrency}`,
          `Repo root: ${path.resolve(plan.repoRoot)}`,
          `Worktree: ${plan.checkout.effectiveWorktreeName}`,
          `Branch: ${plan.checkout.effectiveBranchName}`,
          '',
          'Daemon started in background.',
          'Run `afk tui` to attach and view progress.',
        ].join('\n'),
      };
    }

    const permissionCoordinator = new PermissionCoordinator({
      ticketLabel: selectedTickets[0]?.label,
      autoApprove: true,
    });
    const executionProvider = createAgentExecutionProvider(harness, implementationExecutor, permissionCoordinator);
    const reviewerProvider = createAgentExecutionProvider(reviewerHarness, reviewerExecutor, permissionCoordinator);
    const runner = new SingleTicketRunner(
      runtimeStore,
      new CompositeAgentExecutionProvider(executionProvider, reviewerProvider),
      launchPreferences.budgets,
    );
    const renderer: OpenTUIRenderer = {
      capabilities: { notifications: io.stdout.isTTY ?? false },
      notify: io.stdout.isTTY
        ? (title: string, message: string) => {
            io.stdout.write(`\x1b]777;notify;${title};${message}\x07`);
          }
        : undefined,
    };
    const notificationPolicy = new NotificationPolicy();
    const notificationAdapter = new OpenTUINotificationAdapter(renderer);
    const eventStream = new ActiveRunEventStream(repoRoot, runId);
    let currentRunState: 'running' | 'paused' = 'running';

    const applyPause = () => {
      if (currentRunState === 'paused') return;
      currentRunState = 'paused';
      scheduler.pause();
      activeRunControlPlane.transition(runId, 'paused');
      view.setRunState?.('paused');
      const event: import('./types.js').AgentExecutionProgressEvent = { ticketLabel: '__run__', message: 'run paused' };
      eventStream.appendProgress(event);
      view.update(event);
    };

    const applyResume = () => {
      if (currentRunState === 'running') return;
      currentRunState = 'running';
      scheduler.resume();
      activeRunControlPlane.transition(runId, 'running');
      view.setRunState?.('running');
      const event: import('./types.js').AgentExecutionProgressEvent = {
        ticketLabel: '__run__',
        message: 'run resumed',
      };
      eventStream.appendProgress(event);
      view.update(event);
    };

    const view = createLiveRunView({
      kind: io.stdout.isTTY ? 'dashboard' : 'text',
      stdout: io.stdout,
      isPromptActive: () => permissionCoordinator.promptActive,
      providerName: providerNameFromHarness(harness),
      selectedTickets: plan.tickets,
      repoRoot,
      runOptions: {
        runId,
        modelId: plan.model.id,
        harness,
        reviewerModelId: plan.reviewerModel?.id,
        reviewerHarness,
        concurrency,
      },
      onPauseResume: () => {
        if (currentRunState === 'running') {
          applyPause();
        } else {
          applyResume();
        }
      },
    });
    const progressLine =
      'updateNotificationState' in view ? (view as unknown as { updateNotificationState(state: unknown): void }) : null;
    if (progressLine) {
      progressLine.updateNotificationState({
        capability: renderer.capabilities.notifications ? 'supported' : 'unsupported',
      });
    }

    // Rehydrate view with events from recovered run so TUI shows prior state
    if (isRecoveredRun) {
      const recoveredEvents = new ActiveRunEventStream(repoRoot, runId).readAllEvents();
      for (const event of recoveredEvents) {
        view.update(event);
      }
    }

    const onProgress = (event: import('./types.js').AgentExecutionProgressEvent) => {
      eventStream.appendProgress(event);
      view.update(event);
      const policyEvent = classifyProgressEvent(event);
      if (policyEvent) {
        const payload = notificationPolicy.maybeNotify(policyEvent);
        notificationAdapter.maybeNotify(payload).then((state) => {
          if (payload && progressLine) {
            progressLine.updateNotificationState({
              capability: renderer.capabilities.notifications ? 'supported' : 'unsupported',
              lastDelivery: { state, payload },
            });
          }
        });
      }
    };

    const mergeBackCoordinator = new MergeBackCoordinator({
      agentExecutionProvider: new CompositeAgentExecutionProvider(executionProvider, reviewerProvider),
      runtimeStore,
    });

    const gitMergeBackProvider = new GitFeatureMergeBackProvider(repoRoot, checkoutsByFeature);
    const gitLockProvider = new GitFeatureLockProvider(checkoutsByFeature);

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
    killPollInterval = setInterval(() => {
      if (killController.signal.aborted) return;
      if (view.killRequested()) {
        killController.abort();
        return;
      }
      const { commands, nextOffset } = eventStream.readCommandsFromOffset(commandOffset);
      commandOffset = nextOffset;
      if (commands.includes('kill')) {
        killController.abort();
      }
    }, 500);

    let schedulerResult: Awaited<ReturnType<Scheduler['launch']>>;
    let baseMergeResults: FeatureBaseMergeResult[] = [];
    try {
      commandPollInterval = setInterval(() => {
        const { commands, nextOffset } = activeRunControlPlane.readCommands(runId, lastCommandOffset);
        lastCommandOffset = nextOffset;
        for (const command of commands) {
          if (command.type === 'pause') applyPause();
          else if (command.type === 'resume') applyResume();
        }
      }, 250);

      schedulerResult = await scheduler.launch(plan, {
        onProgress,
        runId,
        signal: killController.signal,
      });
      if (mergeBackToBase && schedulerResult.ticketResults.every((result) => result.outcome === 'completed')) {
        baseMergeResults = await mergeCompletedFeaturesToBase({
          repoRoot,
          baseBranch,
          features: checkoutFeatures,
          checkoutsByFeature,
          coordinator: mergeBackCoordinator,
          model: plan.model,
          reviewerModel: plan.reviewerModel,
          reviewerPrompt: plan.reviewerPrompt,
          onProgress,
        });
      }
      if (killPollInterval) clearInterval(killPollInterval);
      if (killController.signal.aborted) {
        activeRunControlPlane.transition(runId, 'killing');
        activeRunControlPlane.clear(runId);
        view.done();
        return { code: 0, message: 'Run killed' };
      }
      const runOutcomeEvent = classifyRunOutcome({
        runId,
        ticketResults: schedulerResult.ticketResults.map((r) => ({
          ticketLabel: r.ticket.label,
          outcome: r.outcome,
        })),
      });
      if (runOutcomeEvent) {
        const payload = notificationPolicy.maybeNotify(runOutcomeEvent);
        const state = await notificationAdapter.maybeNotify(payload);
        if (payload && progressLine) {
          progressLine.updateNotificationState({
            capability: renderer.capabilities.notifications ? 'supported' : 'unsupported',
            lastDelivery: { state, payload },
          });
        }
      }
    } catch (error) {
      if (commandPollInterval) clearInterval(commandPollInterval);
      if (killPollInterval) clearInterval(killPollInterval);
      view.cleanup();
      throw error;
    }
    if (commandPollInterval) clearInterval(commandPollInterval);
    view.completeRun?.();
    await view.waitForQuit();
    return {
      code: 0,
      message: [
        `Selected model: ${plan.model.id}`,
        `Selected harness: ${harness}`,
        `Selected reviewer model: ${plan.reviewerModel?.id ?? 'unknown'}`,
        `Selected reviewer harness: ${reviewerHarness}`,
        `Reviewer prompt: ${plan.reviewerPrompt?.id ?? 'unknown'}`,
        `Selected tickets (${plan.tickets.length}): ${plan.tickets.map((ticket) => ticket.label).join(', ')}`,
        `Selected features (${selectedFeatures.length}): ${selectedFeatures.join(', ')}`,
        `Concurrency: ${concurrency}`,
        `Repo root: ${path.resolve(plan.repoRoot)}`,
        `Worktree: ${plan.checkout.effectiveWorktreeName}`,
        `Branch: ${plan.checkout.effectiveBranchName}`,
        ...readRunOutcomeLines(runtimeStore, repoRoot, plan.tickets, {
          runId,
          ticketResults: schedulerResult.ticketResults,
        }),
        ...formatFeatureBaseMergeResultLines(baseMergeResults),
        ...formatManualPermissionReviewLines(permissionCoordinator.history),
      ].join('\n'),
    };
  } finally {
    if (killPollInterval) clearInterval(killPollInterval);
    if (clearOnExit) activeRunControlPlane.clear(runId);
  }
}

function formatFeatureBaseMergeResultLines(results: FeatureBaseMergeResult[]): string[] {
  if (!results.length) return [];
  return [
    'Feature base merge results',
    ...results.map((result) => {
      let status: string;
      if (result.success && !result.warning) {
        status = 'merged and cleaned up';
      } else if (result.warning) {
        status = `merged with cleanup warnings (${result.warning})`;
      } else {
        status = `failed (${result.reason ?? 'unknown error'})`;
      }
      return `- ${result.feature}: ${status}`;
    }),
  ];
}

async function attachToActiveRun(
  repoRoot: string,
  io: PromptIO,
  runId: string,
  controlPlane: ActiveRunControlPlane,
): Promise<{ code: number; message: string }> {
  const initialActiveRun = controlPlane.read();
  const parsedStartTime = initialActiveRun ? Date.parse(initialActiveRun.startedAt) : Number.NaN;
  const runPlanTickets = readRunPlan(repoRoot, runId);
  const view = createLiveRunView({
    kind: io.stdout.isTTY ? 'dashboard' : 'text',
    stdout: io.stdout,
    selectedTickets: runPlanTickets ?? [],
    runOptions: { runId, startTime: Number.isFinite(parsedStartTime) ? parsedStartTime : undefined },
    repoRoot,
    onPauseResume: () => {
      const active = controlPlane.read();
      const nextCommand =
        active?.state === 'paused'
          ? { type: 'resume' as const, clientPid: process.pid }
          : { type: 'pause' as const, clientPid: process.pid };
      controlPlane.enqueueCommand(runId, nextCommand);
    },
  });
  const stream = new ActiveRunEventStream(repoRoot, runId);
  let offset = 0;
  let quit = false;
  let lastRunState = initialActiveRun?.state ?? 'running';
  view.setRunState?.(lastRunState === 'paused' ? 'paused' : 'running');
  let killed = false;
  const quitPromise = view.waitForQuit().then(() => {
    quit = true;
  });

  const killPollInterval = setInterval(() => {
    if (view.killRequested()) {
      killed = true;
      stream.appendCommand('kill');
      clearInterval(killPollInterval);
      view.done();
    }
  }, 250);

  while (!quit && !killed) {
    const active = controlPlane.read();
    const { events, nextOffset } = stream.readFromOffset(offset);
    offset = nextOffset;
    if (view.updateMany) view.updateMany(events);
    else for (const event of events) view.update(event);
    if (active && active.state !== lastRunState) {
      lastRunState = active.state;
      view.setRunState?.(active.state === 'paused' ? 'paused' : 'running');
      const event: import('./types.js').AgentExecutionProgressEvent = {
        ticketLabel: '__run__',
        message: active.state === 'paused' ? 'run paused' : 'run resumed',
      };
      view.update(event);
    }
    if (!active || active.runId !== runId) {
      view.completeRun?.();
      view.done();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  clearInterval(killPollInterval);
  await quitPromise;
  return { code: 0, message: killed ? `Kill dispatched for active run ${runId}` : `Attached to active run ${runId}` };
}

function formatHeartbeatAge(ms: number): string {
  return formatDuration(ms);
}

interface RunMetadata {
  modelId?: string;
  harness?: string;
  ticketCount: number;
}

function readRunMetadata(repoRoot: string, runId: string): RunMetadata {
  const metadataRoot = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata');
  if (!existsSync(metadataRoot)) return { ticketCount: 0 };

  let ticketCount = 0;
  let modelId: string | undefined;
  let harness: string | undefined;

  for (const file of readdirSync(metadataRoot)) {
    if (!file.endsWith('.json')) continue;
    try {
      const content = readFileSync(path.join(metadataRoot, file), 'utf8');
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (parsed.RUN_ID !== runId) continue;
      ticketCount++;
      if (!modelId && typeof parsed.EXECUTION_MODEL_ID === 'string') modelId = parsed.EXECUTION_MODEL_ID;
      if (!harness && typeof parsed.EXECUTION_PROVIDER === 'string') {
        harness = parsed.EXECUTION_PROVIDER === 'opencode' ? 'OpenCode' : parsed.EXECUTION_PROVIDER;
      }
    } catch {
      // skip malformed metadata files
    }
  }

  // Fall back to launch preferences if runtime metadata did not yield model/harness
  if (!modelId || !harness) {
    try {
      const prefsPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'launch-preferences.json');
      if (existsSync(prefsPath)) {
        const prefs = JSON.parse(readFileSync(prefsPath, 'utf8')) as Record<string, unknown>;
        if (!modelId && typeof prefs.modelId === 'string') modelId = prefs.modelId;
        if (!harness && typeof prefs.harness === 'string') harness = prefs.harness;
      }
    } catch {
      // ignore unreadable preferences
    }
  }

  return { modelId, harness, ticketCount };
}

export interface RunPlan {
  tickets: TicketRecord[];
}

export function runPlanPath(repoRoot: string, runId: string): string {
  return path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'run-plans', `${runId}.json`);
}

export function writeRunPlan(repoRoot: string, runId: string, tickets: TicketRecord[]): void {
  const filePath = runPlanPath(repoRoot, runId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const plan: RunPlan = { tickets };
  writeFileSync(filePath, JSON.stringify(plan, null, 2), 'utf8');
}

export function readRunPlan(repoRoot: string, runId: string): TicketRecord[] | null {
  const filePath = runPlanPath(repoRoot, runId);
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const plan = parsed as Record<string, unknown>;
    if (!Array.isArray(plan.tickets)) return null;
    const tickets = plan.tickets as unknown[];
    for (const ticket of tickets) {
      if (!ticket || typeof ticket !== 'object') return null;
      const t = ticket as Record<string, unknown>;
      if (typeof t.path !== 'string') return null;
      if (typeof t.feature !== 'string') return null;
      if (typeof t.issueName !== 'string') return null;
      if (typeof t.label !== 'string') return null;
      if (t.status !== undefined && typeof t.status !== 'string') return null;
      if (typeof t.executorAfk !== 'boolean') return null;
      if (t.dependsOn !== undefined && !Array.isArray(t.dependsOn)) return null;
      if (Array.isArray(t.dependsOn)) {
        for (const dep of t.dependsOn) {
          if (typeof dep !== 'string') return null;
        }
      }
    }
    return plan.tickets as TicketRecord[];
  } catch {
    return null;
  }
}

function formatTicketMetadataError(error: unknown): string {
  const reason = error instanceof Error ? error.message : 'Unknown ticket metadata error';
  return [
    'Launch blocked by invalid ticket metadata.',
    reason,
    'Fix: use PRD opening YAML frontmatter with `Depends-On-Features` (max one entry) and issue frontmatter with `Depends-On` as needed.',
  ].join('\n');
}

export function formatManualPermissionReviewLines(history: readonly PermissionDecisionHistoryEntry[]): string[] {
  if (!history.length) return ['Manual permission review: none required.'];

  return [
    'Manual permission review summary:',
    ...history.map((entry) => {
      const patterns = entry.metadata.patterns.length ? entry.metadata.patterns.join(', ') : 'none';
      const decision = entry.safeDefaultReason ? `${entry.decision} (${entry.safeDefaultReason})` : entry.decision;
      return [
        `#${entry.order}`,
        `ticket=${entry.metadata.ticketLabel}`,
        `session=${entry.metadata.sessionId}`,
        `permission=${entry.metadata.permissionId}`,
        `type=${entry.metadata.type}`,
        `title=${entry.metadata.title}`,
        `patterns=${patterns}`,
        `decision=${decision}`,
        `recordedAt=${entry.recordedAt}`,
      ].join(' | ');
    }),
  ];
}

export function orderSelectedTicketsByFeatureGraph(
  selectedTickets: TicketRecord[],
  graphs: Record<string, FeatureExecutionGraph>,
): TicketRecord[] {
  const selectedByKey = new Map(
    selectedTickets.map((ticket) => [`${ticket.feature}/${ticket.issueName}`, ticket] as const),
  );
  const ordered: TicketRecord[] = [];
  const selectedFeatures = [...new Set(selectedTickets.map((ticket) => ticket.feature))];

  for (const feature of selectedFeatures) {
    const graph = graphs[feature];
    const featureTickets = selectedTickets.filter((ticket) => ticket.feature === feature);
    const graphOrder = new Map<string, number>();
    graph?.waves.flat().forEach((issue, index) => {
      graphOrder.set(issue, index);
    });
    featureTickets
      .sort(
        (left, right) =>
          (graphOrder.get(left.issueName) ?? Number.MAX_SAFE_INTEGER) -
            (graphOrder.get(right.issueName) ?? Number.MAX_SAFE_INTEGER) ||
          left.issueName.localeCompare(right.issueName),
      )
      .forEach((ticket) => {
        if (selectedByKey.has(`${ticket.feature}/${ticket.issueName}`)) ordered.push(ticket);
      });
  }

  return ordered;
}

export function validateSelectedTicketDependencies(
  selectedTickets: TicketRecord[],
  allTickets: TicketRecord[],
): string | null {
  const selected = new Set(selectedTickets.map((ticket) => `${ticket.feature}/${ticket.issueName}`));
  const byKey = new Map<string, TicketRecord>(
    allTickets.map((ticket) => [`${ticket.feature}/${ticket.issueName}`, ticket]),
  );
  const completeStatuses = new Set(['done', 'closed', 'complete', 'resolved']);

  for (const ticket of selectedTickets) {
    for (const dependency of ticket.dependsOn ?? []) {
      const key = `${ticket.feature}/${dependency}`;
      if (selected.has(key)) continue;
      const dependencyTicket = byKey.get(key);
      const status = dependencyTicket?.status?.trim().toLowerCase();
      if (!status || !completeStatuses.has(status)) {
        return `Launch blocked: ${ticket.label} depends on incomplete unselected ticket ${key}. Select the dependency or mark it done.`;
      }
    }
  }

  return null;
}

export function validateSelectedFeatureDependencies(
  workspaceGraph: WorkspaceExecutionGraph,
  selectedFeatures: string[],
): string | null {
  for (const feature of selectedFeatures) {
    const featureState = workspaceGraph.features[feature];
    if (featureState?.state === 'blocked') {
      return `Launch blocked: ${feature} has incomplete upstream work.\nReason: ${featureState.blockedReason}\nFix: complete the upstream feature or select it in the same launch.`;
    }
  }
  return null;
}

export function expandSelectedFeaturesToAllTickets(
  selectedTickets: TicketRecord[],
  allTickets: TicketRecord[],
): TicketRecord[] {
  const selectedFeatures = new Set(selectedTickets.map((ticket) => ticket.feature));
  return allTickets.filter((ticket) => selectedFeatures.has(ticket.feature));
}

async function preflightSelectedModels(
  implementationExecutor: OpenCodeSessionExecutor,
  model: LaunchModel,
  reviewerExecutor: OpenCodeSessionExecutor,
  reviewerModel: LaunchModel,
  harness: 'OpenCode' | 'Claude-Kimi',
  reviewerHarness: 'OpenCode' | 'Claude-Kimi',
): Promise<string | null> {
  const implementationFailure = await preflightModel(implementationExecutor, model, 'implementation', harness);
  if (implementationFailure) return implementationFailure;
  if (reviewerModel.id === model.id && reviewerHarness === harness) return null;
  return preflightModel(reviewerExecutor, reviewerModel, 'reviewer', reviewerHarness);
}

async function preflightModel(
  executor: OpenCodeSessionExecutor,
  model: LaunchModel,
  role: 'implementation' | 'reviewer',
  harness: 'OpenCode' | 'Claude-Kimi',
): Promise<string | null> {
  try {
    const result = await executor.run({
      model,
      title: `afk preflight: ${model.id}`,
      agent: role === 'reviewer' ? (harness === 'OpenCode' ? 'review' : undefined) : 'build',
      prompt: 'AFK model availability preflight. Reply OK.',
    });
    const reason = detectPreflightFailureReason(result.output);
    return reason ? formatPreflightFailure(model.id, role, reason, harness) : null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : `${harness} model preflight failed`;
    return formatPreflightFailure(model.id, role, reason, harness);
  }
}

export function detectPreflightFailureReason(output: string[]): string | null {
  const reason = output.find((line) => {
    const classification = classifyProviderFailureFromSource(line, 'agent-output');
    return classification && classification.kind !== 'unknown';
  });
  return reason ?? null;
}

export function formatPreflightFailure(
  modelId: string,
  role: 'implementation' | 'reviewer',
  reason: string,
  harness: 'OpenCode' | 'Claude-Kimi' = 'OpenCode',
): string {
  const classification = classifyProviderFailure(reason);
  const roleLabel = role === 'implementation' ? 'Implementation model' : 'Reviewer model';
  const title =
    classification?.kind === 'model-unavailable' ? `${roleLabel} unavailable` : `${roleLabel} preflight failed`;
  const provider = modelId.includes('/') ? modelId.slice(0, modelId.indexOf('/')) : harness;
  const lines = [
    title,
    '',
    `Selected ${role} model: ${modelId}`,
    `Provider: ${provider}`,
    `Reason: ${classification?.reason ?? reason}`,
  ];
  if (classification?.availableModels.length) {
    lines.push(
      '',
      'Available models from provider error:',
      ...classification.availableModels.map((item) => `- ${item}`),
    );
  }
  const nextStep =
    classification?.kind === 'model-unavailable'
      ? 'No tickets were started. Re-run `afk` and select an available model.'
      : `No tickets were started. Fix the ${harness} provider issue and re-run \`afk\`.`;
  lines.push('', nextStep);
  return lines.join('\n');
}

export function readRunOutcomeLines(
  runtimeStore: RuntimeStore,
  repoRoot: string,
  tickets: Array<{ feature: string; issueName: string; label: string; path?: string }>,
  currentRun?: { runId?: string; ticketResults?: SchedulerTicketResult[]; launchStartedAt?: number },
): string[] {
  const resultsByTicket = new Map(
    (currentRun?.ticketResults ?? []).map((result) => [`${result.ticket.feature}/${result.ticket.issueName}`, result]),
  );
  const ticketLines = tickets.map((ticket) => {
    const result = resultsByTicket.get(`${ticket.feature}/${ticket.issueName}`);
    if (!result) return formatTicketRunOutcome(runtimeStore, repoRoot, ticket, currentRun);
    if (result.outcome === 'not-scheduled') return `${ticket.label}: blocked (not-scheduled) - ${result.message}`;
    if (result.outcome === 'blocked') return `${ticket.label}: blocked - ${result.message}`;
    if (result.outcome === 'failed') return `${ticket.label}: failed before review (runner-failed) - ${result.message}`;
    if (isTerminalTicketStatus(result.ticket.status)) return `${ticket.label}: completed (already done)`;
    return formatTicketRunOutcome(runtimeStore, repoRoot, ticket, currentRun);
  });
  const failed = ticketLines.filter((line) => line.includes('failed before review')).length;
  const blocked = ticketLines.filter((line) => line.includes('blocked')).length;
  const approved = ticketLines.filter((line) => line.includes('approved') || line.includes('completed')).length;

  const aggregate = failed
    ? `Run outcome: ${failed} failed before review${blocked ? `, ${blocked} blocked` : ''}`
    : blocked
      ? `Run outcome: ${blocked} blocked`
      : approved === tickets.length
        ? 'Run outcome: all tickets approved/completed'
        : 'Run outcome: mixed/unknown';

  return [aggregate, ...ticketLines.map((line) => `- ${line}`)];
}

function formatTicketRunOutcome(
  runtimeStore: RuntimeStore,
  repoRoot: string,
  ticket: { feature: string; issueName: string; label: string; path?: string },
  currentRun?: { runId?: string; launchStartedAt?: number },
): string {
  const metadataPath = path.join(
    repoRoot,
    '.scratch',
    '.opencode-afk-logs',
    'runtime-metadata',
    `${ticket.feature}-${ticket.issueName}.json`,
  );

  try {
    const metadata = runtimeStore.readMetadata(metadataPath);
    if (currentRun?.runId && metadata.RUN_ID !== currentRun.runId) {
      return `${ticket.label}: unknown (runtime metadata from different run)`;
    }
    if (
      currentRun?.launchStartedAt &&
      typeof metadata.START_EPOCH === 'number' &&
      metadata.START_EPOCH < currentRun.launchStartedAt
    ) {
      return `${ticket.label}: unknown (stale runtime metadata from previous launch)`;
    }
    if (metadata.FINAL_REVIEW_OUTCOME === 'approved' && metadata.STATUS === 'completed') {
      const ticketCompletionBlock = validateApprovedTicketFile(ticket.path);
      if (ticketCompletionBlock) return `${ticket.label}: blocked (${ticketCompletionBlock})`;
      return `${ticket.label}: approved`;
    }
    if (metadata.FINAL_REVIEW_OUTCOME === 'needs-human') {
      return `${ticket.label}: blocked (${metadata.FAILURE_KIND ?? 'needs-human'}) - ${metadata.FINAL_REVIEW_REASON ?? metadata.UNSAFE_REASON ?? 'needs human'}`;
    }
    if (metadata.FINAL_REVIEW_OUTCOME === 'approved') {
      return `${ticket.label}: blocked (${metadata.FAILURE_KIND ?? 'approval-not-completed'}) - approved review without completed runtime`;
    }
    if (metadata.STATUS === 'blocked')
      return `${ticket.label}: blocked before final review (${metadata.FAILURE_KIND ?? 'unknown'})`;
    if (metadata.STATUS === 'failed' || metadata.STATUS === 'interrupted') {
      return `${ticket.label}: failed before review (${metadata.FAILURE_KIND ?? 'unknown'}) - ${metadata.UNSAFE_REASON ?? 'unknown'}`;
    }
    if (metadata.STATUS === 'completed') return `${ticket.label}: completed without reviewer`;
  } catch {
    return `${ticket.label}: unknown`;
  }

  return `${ticket.label}: unknown`;
}

function validateApprovedTicketFile(ticketPath?: string): string | null {
  if (!ticketPath) return null;
  try {
    const content = readFileSync(ticketPath, 'utf8');
    if (!/^##\s+AFK Summary\s*$/im.test(content)) return 'missing-afk-summary';
    const status = readTicketStatus(content)?.trim().toLowerCase();
    if (!isTerminalTicketStatus(status)) return 'ticket-status-not-done';
  } catch {
    return 'ticket-file-unreadable';
  }
  return null;
}

function isTerminalTicketStatus(status?: string): boolean {
  return !!status && new Set(['done', 'closed', 'complete', 'resolved']).has(status.trim().toLowerCase());
}

function readTicketStatus(content: string): string | undefined {
  const frontmatterStatus = readFrontmatter(content)?.match(/^status:\s*(.+)$/im)?.[1];
  return frontmatterStatus;
}

function readFrontmatter(content: string): string | null {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---\n', 4);
  return end === -1 ? null : content.slice(4, end);
}

function createExecutor(harness: 'OpenCode' | 'Claude-Kimi'): OpenCodeSessionExecutor {
  if (harness === 'Claude-Kimi') return new ClaudeCodeSessionExecutor('kimi');
  return new SDKOpenCodeSessionExecutor();
}

function createAgentExecutionProvider(
  harness: 'OpenCode' | 'Claude-Kimi',
  executor: OpenCodeSessionExecutor,
  permissionCoordinator?: PermissionCoordinator,
): AgentExecutionProvider {
  if (harness === 'Claude-Kimi') return new ClaudeKimiAgentExecutionProvider(executor, permissionCoordinator);
  return new OpenCodeAgentExecutionProvider(executor, permissionCoordinator);
}

function providerNameFromHarness(harness: 'OpenCode' | 'Claude-Kimi'): string {
  if (harness === 'Claude-Kimi') return 'claude-kimi';
  return 'opencode';
}

export function getDaemonSpawnCommand(contextPath: string): { command: string; args: string[] } {
  const script = process.argv[1];
  const isCompiled = !script || (!script.endsWith('.ts') && !script.endsWith('.js'));
  if (isCompiled) {
    return { command: resolveCompiledSelfCommand(), args: ['__daemon', contextPath] };
  }
  return { command: process.argv[0], args: [script, '__daemon', contextPath] };
}

function resolveCompiledSelfCommand(): string {
  for (const candidate of [process.argv[1], process.argv[0], process.execPath]) {
    if (!candidate || candidate.startsWith('/$bunfs/') || path.basename(candidate) === 'bun') continue;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  if (process.argv[1]?.startsWith('/$bunfs/') && path.basename(process.execPath) === 'bun') {
    return path.join(path.dirname(process.execPath), 'afk');
  }
  try {
    return resolveExecutable('afk');
  } catch {}
  return process.argv[0];
}

function defaultSpawnDaemon(context: DaemonLaunchContext): SpawnDaemonHandle {
  const contextPath = path.join(
    context.repoRoot,
    '.scratch',
    '.opencode-afk-logs',
    `daemon-context-${context.runId}.json`,
  );
  writeFileSync(contextPath, JSON.stringify(context), 'utf8');

  const logDir = path.join(context.repoRoot, '.scratch', '.opencode-afk-logs');
  const outLog = path.join(logDir, 'daemon.out.log');
  const errLog = path.join(logDir, 'daemon.err.log');
  const out = openSync(outLog, 'a');
  const err = openSync(errLog, 'a');

  const { command, args } = getDaemonSpawnCommand(contextPath);
  const child = spawn(command, args, {
    detached: true,
    stdio: ['ignore', out, err],
    cwd: context.repoRoot,
  });

  return {
    pid: child.pid,
    unref: () => child.unref(),
    on: (event, callback) => child.on(event, callback),
  };
}
