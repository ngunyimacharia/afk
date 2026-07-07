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
import { CompositeAgentExecutionProvider } from './agent-execution-provider.js';
import { CleanupExecutor, CleanupPlanner, readPendingPostMergeCleanupItems } from './cleanup.js';
import { isValidCommand, type ParsedCliArgs, parseCliArgs } from './cli-flags.js';
import {
  type CliResult,
  formatJsonError,
  formatJsonSuccess,
  formatJsonSuccessWithData,
  formatNotImplemented,
  formatUnknownCommand,
} from './cli-response.js';
import { type DaemonLaunchContext, runDaemon } from './daemon.js';
import {
  logResolvedExecutables,
  RequiredExecutableError,
  resolveExecutable,
  resolveExecutables,
} from './executable-resolution.js';
import {
  type FeatureBaseMergeResult,
  featuresWithAllTicketsCompleted,
  mergeCompletedFeaturesToBase,
} from './feature-base-merge.js';
import { buildFeatureExecutionGraph, type FeatureExecutionGraph } from './feature-execution-graph.js';
import { FeatureExecutionRefreshService } from './feature-execution-refresh.js';
import { createPullRequestsForCompletedFeatures, type FeaturePrCreationResult } from './feature-pr-creation.js';
import { GitFeatureLockProvider, GitFeatureMergeBackProvider } from './git-feature-providers.js';
import {
  discoverAvailableHarnesses,
  discoverHarnessModels,
  displayNameForHarness,
  isSelectableHarnessId,
  providerNameForHarness,
  type SelectableHarnessId,
} from './harness-registry.js';
import { isInteractiveLaunchAllowed, type PromptIO, runInteractiveLaunchWizard } from './interactive-launch.js';
import { buildLaunchPlan } from './launch-context-builder.js';
import {
  discoverLinearFeatures,
  LinearGraphqlClient,
  type LinearParentFeature,
  type ResolvedLinearConfig,
  resolveLinearConfig,
} from './linear.js';
import {
  createLinearPlan,
  createLinearProviderFromConfig,
  type LinearPlanManifest,
  loadLinearPlanManifest,
} from './linear-plan.js';
import type { LinearProvider } from './linear-provider.js';
import { createLiveRunView } from './live-run-view.js';
import { MergeBackCoordinator } from './merge-back-coordinator.js';
import { classifyProgressEvent, classifyRunOutcome, NotificationPolicy } from './notification-policy.js';
import { formatDuration } from './opentui-dashboard.js';
import { OpenTUINotificationAdapter, type OpenTUIRenderer } from './opentui-notification-adapter.js';
import { assertPathWithinRoot } from './path-validation.js';
import type { PermissionDecisionHistoryEntry } from './permission-coordinator.js';
import { PermissionCoordinator } from './permission-coordinator.js';
import { type AfkProjectConfig, inferTrackerProviderKind, loadAfkProjectConfig } from './project-config.js';
import { resolveReviewerPromptTemplate } from './reviewer-prompt-catalog.js';
import { RuntimeStore } from './runtime-store.js';
import { detectDockerAvailable } from './sandbox-selection.js';
import { SandcastleAgentExecutionProvider } from './sandcastle-agent-execution-provider.js';
import { resolveSandcastleAgentProvider, validateSandcastleDockerAuth } from './sandcastle-provider.js';
import {
  AFK_RUNTIME_IMAGE,
  DockerSandcastleRuntimeImageClient,
  validateSandcastleRuntimeImage,
} from './sandcastle-runtime-image-contract.js';
import { SandcastleWorktreeService } from './sandcastle-worktree-service.js';
import { Scheduler, type SchedulerTicketResult } from './scheduler.js';
import { createDefaultTrackerProvider } from './scratch-tracker-provider.js';
import type { ScratchWorktreeService } from './scratch-worktree-service.js';
import { SingleTicketRunner } from './single-ticket-runner.js';
import { SummaryReporter } from './summary-reporter.js';
import { runSync } from './sync/runner.js';
import type { TrackerProvider } from './tracker-contract.js';
import { trackerWorkItemToTicketRecord } from './tracker-contract.js';
import type { FeatureCompletionAction, LaunchModel, LaunchPreferences, SandboxMode, TicketRecord } from './types.js';
import {
  checkForUpgrade,
  defaultDownloadAsset,
  defaultReexec,
  defaultReplaceBinary,
  fetchLatestGitHubRelease,
  isSourceMode,
  resolveTargetPath,
  type UpgradeDependencies,
} from './upgrade.js';
import { VERSION } from './version.js';
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
  const labels = item.labels.map((label) => label.name).join(', ') || 'None';
  return [
    `# ${item.title}`,
    '',
    `Linear issue ID: ${item.id}`,
    `Linear issue key: ${item.key}`,
    `Linear issue: ${item.url}`,
    `Linear status: ${item.status}`,
    `Linear parent: ${feature.key} - ${feature.title}`,
    `Linear parent URL: ${feature.url}`,
    `Linear labels: ${labels}`,
    `Dependency summary: None discovered by AFK Linear discovery.`,
    '',
    body || '_No Linear description provided._',
    '',
  ].join('\n');
}

export function linearMirrorRoot(repoRoot: string): string {
  return path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'linear-mirrors');
}

export function linearMirrorPath(repoRoot: string, featureSlug: string, issueName: string): string {
  const root = path.resolve(linearMirrorRoot(repoRoot));
  const safeFeature = linearIssueSlug(featureSlug);
  const safeIssue = linearIssueSlug(issueName);
  if (!safeFeature || !safeIssue) throw new Error(`Invalid Linear mirror name for ${featureSlug}/${issueName}`);
  const mirrorPath = path.join(root, `${safeFeature}-${safeIssue}.md`);
  assertPathWithinRoot(mirrorPath, root, 'Linear mirror');
  return mirrorPath;
}

export function materializeLinearTicketMirrors(repoRoot: string, tickets: TicketRecord[]): TicketRecord[] {
  const root = path.resolve(linearMirrorRoot(repoRoot));
  mkdirSync(root, { recursive: true });
  return tickets.map((ticket) => {
    if (ticket.source !== 'linear') return ticket;
    const mirrorPath = linearMirrorPath(repoRoot, ticket.feature, ticket.issueName);
    const providerIdentity = ticket.providerIdentity ? { ...ticket.providerIdentity, mirrorPath } : undefined;
    const content = ticket.content ?? '';
    writeFileSync(mirrorPath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
    return { ...ticket, path: mirrorPath, content, providerIdentity };
  });
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
          featureTitle: feature.title,
          issueName,
          label: `${feature.featureSlug}/${issueName}`,
          title: item.title,
          status: 'ready-for-agent',
          executorAfk: true,
          dependsOn: (item.dependsOn ?? []).map(linearIssueSlug).filter(Boolean),
          source: 'linear' as const,
          linear: {
            parentKey: feature.key,
            issueKey: item.key,
            parentBranchName: feature.branchName,
            issueBranchName: item.branchName,
          },
          content: linearTicketContent(feature, item),
          providerIdentity: {
            provider: 'linear' as const,
            issueId: item.id,
            issueKey: item.key,
            issueUrl: item.url,
            parentKey: feature.key,
          },
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

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

export interface SpawnDaemonHandle {
  pid: number | undefined;
  unref: () => void;
  on: (event: 'exit' | 'error', callback: (code?: number | null, signal?: NodeJS.Signals | null) => void) => void;
}

interface JsonOutputData {
  ok: boolean;
  command: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

function jsonOk(command: string, data: Record<string, unknown>): string {
  const output: JsonOutputData = { ok: true, command, data };
  return JSON.stringify(output, null, 2);
}

function jsonError(command: string, code: string, message: string, details?: Record<string, unknown>): string {
  const output: JsonOutputData = { ok: false, command, error: { code, message, details } };
  return JSON.stringify(output, null, 2);
}

export interface RunAfkRuntime {
  argv?: string[];
  io?: PromptIO;
  env?: NodeJS.ProcessEnv;
  spawnDaemon?: (context: DaemonLaunchContext) => SpawnDaemonHandle;
  trackerProvider?: TrackerProvider;
  inlineLaunch?: boolean;
  stopTimeoutMs?: number;
  stopPollIntervalMs?: number;
  linearProvider?: LinearProvider;
  linearManifest?: LinearPlanManifest;
  discoverAvailableHarnesses?: (
    discoverModels?: (harness: SelectableHarnessId, repoRoot?: string) => Promise<LaunchModel[]>,
    repoRoot?: string,
  ) => Promise<{
    availableHarnesses: SelectableHarnessId[];
    harnessModelCache: Partial<Record<SelectableHarnessId, LaunchModel[]>>;
  }>;
  upgradeDependencies?: UpgradeDependencies;
  skipUpgradeCheck?: boolean;
  detectDockerAvailable?: () => boolean;
  validateSandcastleRuntimeImage?: typeof validateSandcastleRuntimeImage;
  dockerAuthPathExists?: (path: string) => boolean;
}

export async function runAfk(repoRoot = process.cwd(), runtime: RunAfkRuntime = {}): Promise<CliResult> {
  const argv = runtime.argv ?? process.argv;
  const parsed = parseCliArgs(argv);
  const command = parsed.command;
  const isJson = parsed.flags.json;

  if (parsed.flags.version || command === 'version') {
    if (isJson) {
      return formatJsonSuccessWithData('version', { version: VERSION });
    }
    return { code: 0, message: VERSION };
  }

  const upgradeResult = await maybeCheckForUpgrade(argv, parsed, runtime);
  if (upgradeResult) {
    return upgradeResult;
  }

  const incompleteCommands = new Set(['plan', 'events']);
  if (command && incompleteCommands.has(command)) {
    return formatNotImplemented(command, isJson);
  }

  if (command && !isValidCommand(command)) {
    return formatUnknownCommand(command, isJson);
  }

  try {
    const result = await runAfkInternal(repoRoot, runtime, parsed);
    if (!isJson) return result;
    if (command && new Set(['run', 'stop', 'status', 'pause', 'resume']).has(command)) return result;
    if (result.code !== 0) {
      return formatJsonError(command, 'command-failed', result.message);
    }
    if (command === 'linear-plan') {
      try {
        const data = JSON.parse(result.message) as object;
        return formatJsonSuccessWithData(command, data);
      } catch {
        return formatJsonSuccess(command, result.message);
      }
    }
    return formatJsonSuccess(command, result.message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isJson) return { code: 1, message };
    return formatJsonError(command, 'command-failed', message);
  }
}

async function maybeCheckForUpgrade(
  argv: string[],
  parsed: ParsedCliArgs,
  runtime: RunAfkRuntime,
): Promise<CliResult | undefined> {
  if (runtime.skipUpgradeCheck) return undefined;

  const env = runtime.env ?? process.env;
  const io = runtime.io ?? { stdin: process.stdin, stdout: process.stdout };
  const targetPath = resolveTargetPath(argv);
  const isInteractive = !!io.stdin.isTTY && !!io.stdout.isTTY && !env.CI;

  const dependencies = runtime.upgradeDependencies ?? {
    fetchLatestRelease: () => fetchLatestGitHubRelease('ngunyimacharia', 'afk'),
    prompt: async (message: string) => {
      const prompts = (await import('prompts')).default;
      const result = await prompts({
        type: 'confirm',
        name: 'value',
        message,
        initial: true,
      });
      return result.value === true;
    },
    downloadAsset: defaultDownloadAsset,
    replaceBinary: defaultReplaceBinary,
    reexec: defaultReexec,
  };

  const upgrade = await checkForUpgrade(
    {
      currentVersion: VERSION,
      argv,
      targetPath,
      isInteractive,
      isJson: parsed.flags.json,
      isSourceMode: isSourceMode(targetPath),
    },
    dependencies,
  );

  if (upgrade.action === 'restarted') {
    // `reexec` never resolves; this path is only reached in tests with a stub.
    return { code: 0, message: '' };
  }

  if (upgrade.message && upgrade.action === 'skipped') {
    io.stdout.write(`${upgrade.message}\n`);
  }

  return undefined;
}

async function runAfkInternal(repoRoot: string, runtime: RunAfkRuntime, parsed: ParsedCliArgs): Promise<CliResult> {
  const io = runtime.io ?? { stdin: process.stdin, stdout: process.stdout };
  const env = runtime.env ?? process.env;
  const command = parsed.command;

  try {
    const resolvedExecutables = resolveExecutables(['git', 'which']);
    if (parsed.flags.verbose || env.AFK_DEBUG) {
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
    const isDryRun = parsed.flags.dryRun;
    const planner = new CleanupPlanner({ repoRoot });
    const plan = planner.buildPlan();
    const logTargets = plan.terminalTargets
      .flatMap((target) => [
        target.logPath,
        target.metadataPath,
        target.linearMirrorPath,
        target.doneSentinelPath,
        target.failedSentinelPath,
      ])
      .filter(Boolean) as string[];
    if (plan.workspaceExecutionPath) logTargets.push(plan.workspaceExecutionPath);
    const sandcastleTargets = (plan.sandcastleResourceTargets ?? []).map(
      (target) =>
        `- ${target.feature}/${target.issueName} ${target.resource.type} id=${target.resource.id}${target.resource.path ? ` path=${target.resource.path}` : ''}${target.resource.cleanupCommand ? ` command=${target.resource.cleanupCommand}` : ''}`,
    );
    const dryRun = [
      'AFK Cleanup Plan',
      '',
      'Terminal tickets to delete',
      ...(plan.terminalTargets.length
        ? plan.terminalTargets.map(
            (target) => `- ${target.issuePath ?? target.metadataPath ?? `${target.feature}/${target.issueName}`}`,
          )
        : ['- none']),
      '',
      'Matching logs / metadata to delete',
      ...(logTargets.length ? logTargets.map((filePath) => `- ${filePath}`) : ['- none']),
      '',
      'Sandcastle cleanup resources',
      ...(sandcastleTargets.length ? sandcastleTargets : ['- none']),
      '',
      'Pending failed post-merge cleanup retries',
      ...(plan.pendingPostMergeCleanupTargets.length
        ? plan.pendingPostMergeCleanupTargets.map(
            (item) =>
              `- ${item.feature}/${item.issueName} branch=${item.branchName} worktree=${item.worktreePath} (${item.warning ?? item.error ?? 'pending retry'})`,
          )
        : ['- none']),
      '',
      'Orphaned issue worktrees to remove',
      ...(plan.orphanedWorktreeTargets.length
        ? plan.orphanedWorktreeTargets.map(
            (item) => `- ${item.feature}/${item.issueName} branch=${item.branchName} worktree=${item.worktreePath}`,
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
    const orphanedWorktreeResults = [
      'Orphaned issue worktree cleanup results',
      ...(result.orphanedWorktreeResults.length
        ? result.orphanedWorktreeResults.map((item) =>
            item.success
              ? `- ${item.feature}/${item.issueName}: removed`
              : `- ${item.feature}/${item.issueName}: skipped (${item.warning ?? item.error ?? 'unknown error'})`,
          )
        : ['- none']),
    ].join('\n');
    const sandcastleResults = [
      'Sandcastle cleanup results',
      ...(plan.sandcastleResourceTargets?.length
        ? plan.sandcastleResourceTargets.map((target) => {
            const record = JSON.parse(readFileSync(target.recordPath, 'utf8'));
            const result = record.cleanupResults?.find(
              (item: { resourceId: string; resourceType: string }) =>
                item.resourceId === target.resource.id && item.resourceType === target.resource.type,
            );
            return `- ${target.feature}/${target.issueName} ${target.resource.type}:${target.resource.id}: ${result?.status ?? 'unknown'}${result?.message ? ` (${result.message})` : ''}`;
          })
        : ['- none']),
    ].join('\n');
    return {
      code: 0,
      message: `${dryRun}\n\n${sandcastleResults}\n\n${retryResults}\n\n${orphanedWorktreeResults}\n\nExecuted:\n${result.deleted.map((item) => `- ${item}`).join('\n') || '- none'}`,
    };
  }
  if (command === 'sync') return runSync();
  if (command === 'linear-plan') {
    const providerConfig = createLinearProviderFromConfig(repoRoot);
    if (!providerConfig.provider || !providerConfig.teamId || !providerConfig.setup)
      return { code: 1, message: providerConfig.errors.join('\n') };
    const manifestPath = parsed.flags.manifest ?? parsed.positionals[0];
    if (!runtime.linearManifest && !manifestPath) return { code: 1, message: 'Manifest path required.' };
    const manifestResult = runtime.linearManifest
      ? { manifest: runtime.linearManifest, errors: [] }
      : loadLinearPlanManifest(manifestPath ?? '');
    const manifest = manifestResult.manifest;
    if (!manifest) {
      return { code: 1, message: manifestResult.errors.join('\n') };
    }
    let result: Awaited<ReturnType<typeof createLinearPlan>>;
    try {
      result = await createLinearPlan({
        manifest,
        teamId: providerConfig.teamId,
        provider: runtime.linearProvider ?? providerConfig.provider,
        setup: providerConfig.setup,
      });
    } catch (error) {
      return { code: 1, message: error instanceof Error ? error.message : String(error) };
    }
    return { code: 0, message: JSON.stringify(result, null, 2) };
  }
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
      if (parsed.flags.json) {
        return {
          code: 1,
          message: jsonError('stop', 'no-active-run', 'No active AFK run'),
        };
      }
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
        if (parsed.flags.json) {
          return {
            code: 0,
            message: jsonOk('stop', { runId: activeRun.runId, stopped: true }),
          };
        }
        return { code: 0, message: `Stopped AFK run ${activeRun.runId}` };
      }
    }
    if (parsed.flags.json) {
      return {
        code: 1,
        message: jsonError(
          'stop',
          'stop-timeout',
          `AFK run ${activeRun.runId} did not stop within ${stopTimeoutMs / 1000}s`,
          {
            runId: activeRun.runId,
            timeoutMs: stopTimeoutMs,
          },
        ),
      };
    }
    return { code: 1, message: `Timeout: AFK run ${activeRun.runId} did not stop within ${stopTimeoutMs / 1000}s` };
  }
  if (command === 'status') {
    const activeRunControlPlane = new ActiveRunControlPlane({ repoRoot });
    const activeRun = activeRunControlPlane.read();
    const pendingCleanupCount = readPendingPostMergeCleanupItems(repoRoot).length;
    if (!activeRun || !activeRunControlPlane.isHealthy(activeRun)) {
      if (parsed.flags.json) {
        return {
          code: 0,
          message: jsonOk('status', { active: false, pendingPostMergeCleanupDebt: pendingCleanupCount }),
        };
      }
      const lines = ['No active AFK run'];
      if (pendingCleanupCount > 0) lines.push(`Pending post-merge cleanup debt: ${pendingCleanupCount}`);
      return { code: 0, message: lines.join('\n') };
    }
    const runMetadata = readRunMetadata(repoRoot, activeRun.runId);
    const heartbeatAgeMs = Date.now() - Date.parse(activeRun.heartbeatAt);
    if (parsed.flags.json) {
      const data: Record<string, unknown> = {
        active: true,
        runId: activeRun.runId,
        pid: activeRun.pid,
        state: activeRun.state,
        heartbeatAgeMs,
        startedAt: activeRun.startedAt,
        ticketCount: runMetadata.ticketCount,
        pendingPostMergeCleanupDebt: pendingCleanupCount,
      };
      if (runMetadata.modelId) data.modelId = runMetadata.modelId;
      if (runMetadata.harness) data.harness = runMetadata.harness;
      return { code: 0, message: jsonOk('status', data) };
    }
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
    if (pendingCleanupCount > 0) lines.push(`Pending post-merge cleanup debt: ${pendingCleanupCount}`);
    return { code: 0, message: lines.join('\n') };
  }
  if (command === 'pause' || command === 'resume') {
    const activeRunControlPlane = new ActiveRunControlPlane({ repoRoot });
    const activeRun = activeRunControlPlane.read();
    if (!activeRun || !activeRunControlPlane.isHealthy(activeRun)) {
      if (parsed.flags.json) {
        return {
          code: 1,
          message: jsonError(command, 'no-active-run', 'No healthy active run'),
        };
      }
      return { code: 1, message: 'No healthy active run' };
    }
    activeRunControlPlane.enqueueCommand(activeRun.runId, { type: command, clientPid: process.pid });
    if (parsed.flags.json) {
      return {
        code: 0,
        message: jsonOk(command, { runId: activeRun.runId, targetState: command === 'pause' ? 'paused' : 'running' }),
      };
    }
    return { code: 0, message: `Enqueued ${command} for active run ${activeRun.runId}` };
  }
  if (command === '__daemon') {
    const contextPath = parsed.positionals[0];
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
  if (command === 'run') {
    return runHeadlessLaunch({
      repoRoot,
      runtime,
      env,
      launchPreferences,
      projectConfig: projectConfig.config,
    });
  }
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
    let allTickets: TicketRecord[];
    let tickets: TicketRecord[];
    try {
      const provider =
        runtime.trackerProvider ??
        createDefaultTrackerProvider(repoRoot, inferTrackerProviderKind(activeProjectConfig));
      const launchTickets = await discoverLaunchTickets(provider);
      allTickets = launchTickets.allTickets;
      tickets = launchTickets.eligibleTickets;
    } catch (error) {
      return { code: 1, message: formatTicketMetadataError(error) };
    }
    let resolvedLinearConfig: ResolvedLinearConfig | undefined;
    if (activeProjectConfig.linear) {
      try {
        const client = new LinearGraphqlClient(activeProjectConfig.linear.apiKey ?? '');
        const resolvedConfig = await resolveLinearConfig({
          config: activeProjectConfig.linear,
          projectId: activeProjectConfig.linear.projectId,
          env,
          client,
        });
        resolvedLinearConfig = resolvedConfig;
        const linearFeatures = await discoverLinearFeatures({
          resolvedConfig: resolvedLinearConfig,
          client: new LinearGraphqlClient(activeProjectConfig.linear.apiKey ?? ''),
        });
        const linearTickets = linearFeaturesToTicketRecords(linearFeatures);
        allTickets = [...allTickets, ...linearTickets];
        tickets = [...tickets, ...linearTickets];
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown Linear config error';
        return { code: 1, message: `Linear sync config failed.\nReason: ${reason}` };
      }
    }
    let launchTickets = [...allTickets];
    if (!tickets.length) return { code: 0, message: 'No pending AFK tickets found' };
    const worktreePreparationService = new WorktreePreparationService();
    let model: LaunchModel | undefined;
    let reviewerModel: LaunchModel | undefined;
    let reviewerPrompt: { id: string; label: string; path: string } | undefined;
    let selectedTickets: TicketRecord[] = [];
    let concurrency = 3;
    let mergeBackToBase = false;
    let featureCompletionAction: FeatureCompletionAction = 'merge-to-base';
    let harness: SelectableHarnessId = 'OpenCode';
    let reviewerHarness: SelectableHarnessId = 'OpenCode';
    let sandboxMode: SandboxMode =
      launchPreferences.sandboxMode ?? launchPreferences.sandcastleSandboxMode ?? 'no-sandbox';

    const { availableHarnesses, harnessModelCache } = await (
      runtime.discoverAvailableHarnesses ?? discoverAvailableHarnesses
    )(undefined, repoRoot);

    if (availableHarnesses.length === 0) {
      return {
        code: 0,
        message: 'No harnesses available. Install and configure OpenCode, Claude, Codex, or PI.',
      };
    }

    try {
      const dockerAvailable = detectDockerAvailable();
      const wizard = await runInteractiveLaunchWizard({
        io,
        repoRoot,
        availableHarnesses,
        discoverModels: async (selectedHarness) => {
          if (harnessModelCache[selectedHarness]) return harnessModelCache[selectedHarness];
          return discoverHarnessModels(selectedHarness);
        },
        tickets,
        preferences: launchPreferences,
        dockerAvailable,
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
      featureCompletionAction = wizard.featureCompletionAction ?? (mergeBackToBase ? 'merge-to-base' : 'create-pr');
      sandboxMode = wizard.sandboxMode ?? 'no-sandbox';
      runtimeStore.writeLaunchPreferences({
        harness: wizard.harness,
        modelId: model?.id,
        reviewerHarness: wizard.reviewerHarness,
        reviewerModelId: reviewerModel?.id,
        sandcastleSandboxMode: sandboxMode,
        concurrency,
        featureCompletionAction: wizard.featureCompletionAction,
        sandboxMode,
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
    if (sandboxMode === 'docker') {
      const dockerBlock = await validateDockerHeadlessPrerequisites(
        'run',
        false,
        runtime,
        env,
        harness,
        reviewerHarness,
        model,
        reviewerModel,
      );
      if (dockerBlock) return dockerBlock;
    }
    const selectedFeatures = [...new Set(selectedTickets.map((ticket) => ticket.feature))];
    selectedTickets = expandSelectedFeaturesToAllTickets(selectedTickets, launchTickets);
    selectedTickets = materializeLinearTicketMirrors(repoRoot, selectedTickets);
    launchTickets = launchTickets.map(
      (ticket) => selectedTickets.find((selected) => selected.label === ticket.label) ?? ticket,
    );
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
        const linearTicket = selectedTickets.find((ticket) => ticket.feature === feature && ticket.source === 'linear');
        return worktreePreparationService.prepare({
          repoRoot,
          featureSlug: feature,
          linearIssueKey: linearTicket?.linear?.parentKey,
          linearIssueBranchName: linearTicket?.linear?.parentBranchName,
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
    for (const [feature, checkout] of Object.entries(checkoutsByFeature)) {
      io.stdout.write(
        `Feature checkout '${feature}': branch=${checkout.effectiveBranchName} (source=${checkout.branchNameSource}), worktree=${checkout.worktreePath}\n`,
      );
    }
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
      sandboxMode,
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
        featureCompletionAction,
        sandcastleSandboxMode: sandboxMode,
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
          `Selected sandbox: ${plan.sandboxMode ?? 'no-sandbox'}`,
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
    const executionProvider = new SandcastleAgentExecutionProvider();
    const reviewerProvider = executionProvider;
    const runner = new SingleTicketRunner(
      runtimeStore,
      new CompositeAgentExecutionProvider(executionProvider, reviewerProvider),
      launchPreferences.budgets,
      resolvedLinearConfig
        ? {
            resolvedConfig: resolvedLinearConfig,
            client: new LinearGraphqlClient(activeProjectConfig.linear?.apiKey ?? ''),
          }
        : undefined,
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
      providerName: providerNameForHarness(harness),
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
      sandcastleWorktreeService: new SandcastleWorktreeService(),
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
        issueCheckouts: Record<string, ReturnType<ScratchWorktreeService['createScratchWorktree']>>,
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
    let prCreationResults: FeaturePrCreationResult[] = [];
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
      if (featureCompletionAction === 'merge-to-base') {
        const eligibleFeatures = featuresWithAllTicketsCompleted(schedulerResult.ticketResults, checkoutFeatures);
        if (eligibleFeatures.length > 0) {
          baseMergeResults = await mergeCompletedFeaturesToBase({
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
      } else if (featureCompletionAction === 'create-pr') {
        const eligibleFeatures = featuresWithAllTicketsCompleted(schedulerResult.ticketResults, checkoutFeatures);
        if (eligibleFeatures.length > 0) {
          prCreationResults = await createPullRequestsForCompletedFeatures({
            repoRoot,
            baseBranch,
            features: eligibleFeatures,
            checkoutsByFeature,
            agentExecutionProvider: new CompositeAgentExecutionProvider(executionProvider, reviewerProvider),
            model: plan.model,
            ticketResults: schedulerResult.ticketResults,
            onProgress,
          });
        }
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
        ...formatFeaturePrCreationResultLines(prCreationResults),
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

export function formatFeaturePrCreationResultLines(results: FeaturePrCreationResult[]): string[] {
  if (!results.length) return [];
  return [
    'Feature pull request results',
    ...results.map((result) => {
      let status: string;
      if (result.success && result.prUrl) {
        status = result.warning
          ? `pull request created: ${result.prUrl} (cleanup warning: ${result.warning})`
          : `pull request created: ${result.prUrl}`;
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

export function readRunMetadata(repoRoot: string, runId: string): RunMetadata {
  const metadataRoot = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata');
  let ticketCount = 0;
  let modelId: string | undefined;
  let harness: string | undefined;

  if (existsSync(metadataRoot)) {
    for (const file of readdirSync(metadataRoot)) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = readFileSync(path.join(metadataRoot, file), 'utf8');
        const parsed = JSON.parse(content) as Record<string, unknown>;
        if (parsed.RUN_ID !== runId) continue;
        ticketCount++;
        if (!modelId && typeof parsed.EXECUTION_MODEL_ID === 'string') modelId = parsed.EXECUTION_MODEL_ID;
        if (!harness && typeof parsed.EXECUTION_PROVIDER === 'string') {
          harness = displayNameForProvider(parsed.EXECUTION_PROVIDER);
        }
      } catch {
        // skip malformed metadata files
      }
    }
  }

  // Fall back to launch preferences if runtime metadata did not yield model/harness
  if (!modelId || !harness) {
    try {
      const prefsPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'launch-preferences.json');
      if (existsSync(prefsPath)) {
        const prefs = JSON.parse(readFileSync(prefsPath, 'utf8')) as Record<string, unknown>;
        if (!modelId && typeof prefs.modelId === 'string') modelId = prefs.modelId;
        if (!harness && typeof prefs.harness === 'string' && isSelectableHarnessId(prefs.harness)) {
          harness = displayNameForHarness(prefs.harness);
        }
      }
    } catch {
      // ignore unreadable preferences
    }
  }

  return { modelId, harness, ticketCount };
}

export function displayNameForProvider(provider: string): string {
  if (provider === 'opencode') return 'OpenCode';
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  if (provider === 'pi') return 'PI';
  return provider;
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

export async function discoverLaunchTickets(provider: TrackerProvider): Promise<{
  allTickets: TicketRecord[];
  eligibleTickets: TicketRecord[];
}> {
  const items = await provider.list();
  return {
    allTickets: items.map((item) => trackerWorkItemToTicketRecord(item)),
    eligibleTickets: items
      .filter((item) => provider.isEligible(item))
      .map((item) => trackerWorkItemToTicketRecord(item)),
  };
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
      const key = normalizeDependencyLabel(ticket.feature, dependency);
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

function normalizeDependencyLabel(feature: string, dependency: string): string {
  return dependency.includes('/') ? dependency : `${feature}/${dependency}`;
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

function parseStringFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index >= 0) return argv[index + 1];
  const prefix = `${flag}=`;
  const prefixed = argv.find((arg) => arg.startsWith(prefix));
  if (prefixed) return prefixed.slice(prefix.length);
  return undefined;
}

function parseCommaSeparatedFlag(argv: string[], flag: string): string[] {
  const value = parseStringFlag(argv, flag);
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function headlessJsonEnvelope(command: string, data: unknown, message = 'Daemon started in background.'): string {
  return JSON.stringify({ ok: true, command, message, data }, null, 2);
}

function headlessJsonError(
  command: string,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): string {
  return JSON.stringify({ ok: false, command, error: { code, message, details } }, null, 2);
}

function headlessFailure(
  command: string,
  isJson: boolean,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): { code: number; message: string } {
  return { code: 1, message: isJson ? headlessJsonError(command, code, message, details) : message };
}

async function validateDockerHeadlessPrerequisites(
  command: string,
  isJson: boolean,
  runtime: RunAfkRuntime,
  env: NodeJS.ProcessEnv,
  harness: SelectableHarnessId,
  reviewerHarness: SelectableHarnessId,
  model: LaunchModel,
  reviewerModel: LaunchModel,
): Promise<{ code: number; message: string } | null> {
  if (!(runtime.detectDockerAvailable ?? detectDockerAvailable)()) {
    return headlessFailure(
      command,
      isJson,
      'docker-unavailable',
      'Docker sandbox mode requires Docker to be available before launch.',
    );
  }
  const imageValidation = await (runtime.validateSandcastleRuntimeImage ?? validateSandcastleRuntimeImage)(
    new DockerSandcastleRuntimeImageClient(),
    AFK_RUNTIME_IMAGE,
  );
  if (!imageValidation.ok) {
    return headlessFailure(command, isJson, 'docker-runtime-image-unavailable', imageValidation.failure.message, {
      ...imageValidation.failure,
    });
  }
  const authInput = { env, pathExists: runtime.dockerAuthPathExists ?? existsSync };
  const failures = [
    {
      role: 'implementation',
      failure: validateSandcastleDockerAuth(
        resolveSandcastleAgentProvider(harness, model, authInput, 'docker'),
        authInput,
      ),
    },
    {
      role: 'reviewer',
      failure: validateSandcastleDockerAuth(
        resolveSandcastleAgentProvider(reviewerHarness, reviewerModel, authInput, 'docker'),
        authInput,
      ),
    },
  ].filter((item): item is { role: string; failure: NonNullable<ReturnType<typeof validateSandcastleDockerAuth>> } =>
    Boolean(item.failure),
  );
  if (failures.length) {
    return headlessFailure(
      command,
      isJson,
      'docker-auth-unavailable',
      failures.map((item) => `${item.role}: ${item.failure.message}`).join('\n'),
      { failures },
    );
  }
  return null;
}

interface HeadlessLaunchInput {
  repoRoot: string;
  runtime: {
    argv?: string[];
    io?: PromptIO;
    env?: NodeJS.ProcessEnv;
    spawnDaemon?: (context: DaemonLaunchContext) => SpawnDaemonHandle;
    trackerProvider?: TrackerProvider;
    inlineLaunch?: boolean;
    linearProvider?: LinearProvider;
    discoverAvailableHarnesses?: (
      discoverModels?: (harness: SelectableHarnessId, repoRoot?: string) => Promise<LaunchModel[]>,
      repoRoot?: string,
    ) => Promise<{
      availableHarnesses: SelectableHarnessId[];
      harnessModelCache: Partial<Record<SelectableHarnessId, LaunchModel[]>>;
    }>;
  };
  env: NodeJS.ProcessEnv;
  launchPreferences: LaunchPreferences;
  projectConfig: AfkProjectConfig;
}

async function runHeadlessLaunch(input: HeadlessLaunchInput): Promise<{ code: number; message: string }> {
  const { repoRoot, runtime, env, launchPreferences, projectConfig } = input;
  const argv = runtime.argv ?? process.argv;
  const isJson = hasFlag(argv, '--json');
  const command = 'run';

  const requiredFlags = [
    { flag: '--harness', name: 'harness' },
    { flag: '--model', name: 'model' },
    { flag: '--reviewer-harness', name: 'reviewer-harness' },
    { flag: '--reviewer-model', name: 'reviewer-model' },
    { flag: '--features', name: 'features' },
    { flag: '--concurrency', name: 'concurrency' },
    { flag: '--completion', name: 'completion' },
    { flag: '--sandbox', name: 'sandbox' },
  ] as const;

  for (const { flag, name } of requiredFlags) {
    const value = parseStringFlag(argv, flag);
    if (!value) {
      return headlessFailure(command, isJson, 'missing-required-flag', `Missing required flag: ${flag}`, {
        flag,
        name,
      });
    }
  }

  const harnessFlag = parseStringFlag(argv, '--harness') as string;
  const modelFlag = parseStringFlag(argv, '--model') as string;
  const reviewerHarnessFlag = parseStringFlag(argv, '--reviewer-harness') as string;
  const reviewerModelFlag = parseStringFlag(argv, '--reviewer-model') as string;
  const featureSlugs = parseCommaSeparatedFlag(argv, '--features');
  const concurrencyFlag = parseStringFlag(argv, '--concurrency') as string;
  const completionFlag = parseStringFlag(argv, '--completion') as string;
  const sandboxFlag = parseStringFlag(argv, '--sandbox') as string;

  if (sandboxFlag !== 'docker' && sandboxFlag !== 'no-sandbox') {
    return headlessFailure(
      command,
      isJson,
      'invalid-sandbox-mode',
      `Invalid sandbox mode: ${sandboxFlag}. Must be 'docker' or 'no-sandbox'.`,
      { sandbox: sandboxFlag },
    );
  }
  const sandboxMode: SandboxMode = sandboxFlag;

  const concurrency = Number(concurrencyFlag);
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    return headlessFailure(
      command,
      isJson,
      'invalid-concurrency',
      `Invalid concurrency: ${concurrencyFlag}. Must be a positive integer.`,
      { concurrency: concurrencyFlag },
    );
  }

  if (completionFlag !== 'merge-to-base' && completionFlag !== 'create-pr') {
    return headlessFailure(
      command,
      isJson,
      'invalid-completion-action',
      `Invalid completion action: ${completionFlag}. Must be 'merge-to-base' or 'create-pr'.`,
      { completion: completionFlag },
    );
  }
  const featureCompletionAction: FeatureCompletionAction = completionFlag;
  const mergeBackToBase = featureCompletionAction === 'merge-to-base';

  const { availableHarnesses, harnessModelCache } = await (
    runtime.discoverAvailableHarnesses ?? discoverAvailableHarnesses
  )(undefined, repoRoot);

  function validateHarnessAndModel(
    harnessValue: string,
    modelValue: string,
    role: 'implementation' | 'reviewer',
  ):
    | { harness: SelectableHarnessId; model: LaunchModel }
    | { code: string; message: string; details: Record<string, unknown> } {
    if (!isSelectableHarnessId(harnessValue)) {
      return {
        code: 'invalid-harness',
        message: `Invalid ${role} harness: ${harnessValue}.`,
        details: { harness: harnessValue, role },
      };
    }
    if (!availableHarnesses.includes(harnessValue)) {
      return {
        code: 'unavailable-harness',
        message: `${role === 'implementation' ? 'Implementation' : 'Reviewer'} harness '${harnessValue}' is not available. Available: ${availableHarnesses.join(', ') || 'none'}.`,
        details: { harness: harnessValue, role, availableHarnesses },
      };
    }
    const models = harnessModelCache[harnessValue] ?? [];
    const model = models.find((item) => item.id === modelValue);
    if (!model) {
      return {
        code: 'invalid-model',
        message: `Invalid ${role} model: ${modelValue} for harness ${harnessValue}. Available models: ${models.map((m) => m.id).join(', ') || 'none'}.`,
        details: { model: modelValue, harness: harnessValue, role, availableModels: models.map((m) => m.id) },
      };
    }
    return { harness: harnessValue, model };
  }

  const implValidation = validateHarnessAndModel(harnessFlag, modelFlag, 'implementation');
  if ('code' in implValidation) {
    return headlessFailure(command, isJson, implValidation.code, implValidation.message, implValidation.details);
  }
  const reviewerValidation = validateHarnessAndModel(reviewerHarnessFlag, reviewerModelFlag, 'reviewer');
  if ('code' in reviewerValidation) {
    return headlessFailure(
      command,
      isJson,
      reviewerValidation.code,
      reviewerValidation.message,
      reviewerValidation.details,
    );
  }

  if (featureSlugs.length === 0) {
    return headlessFailure(command, isJson, 'missing-required-flag', 'Missing required flag: --features', {
      flag: '--features',
      name: 'features',
    });
  }

  if (sandboxMode === 'docker') {
    const dockerBlock = await validateDockerHeadlessPrerequisites(
      command,
      isJson,
      runtime,
      env,
      implValidation.harness,
      reviewerValidation.harness,
      implValidation.model,
      reviewerValidation.model,
    );
    if (dockerBlock) return dockerBlock;
  }

  let allTickets: TicketRecord[];
  let eligibleTickets: TicketRecord[];
  try {
    const provider =
      runtime.trackerProvider ?? createDefaultTrackerProvider(repoRoot, inferTrackerProviderKind(projectConfig));
    const launchTickets = await discoverLaunchTickets(provider);
    allTickets = launchTickets.allTickets;
    eligibleTickets = launchTickets.eligibleTickets;
  } catch (error) {
    const metadataError = formatTicketMetadataError(error);
    return {
      code: 1,
      message: isJson ? headlessJsonError(command, 'ticket-discovery-failed', metadataError) : metadataError,
    };
  }

  if (projectConfig.linear) {
    try {
      const client = new LinearGraphqlClient(projectConfig.linear.apiKey ?? '');
      const resolvedConfig = await resolveLinearConfig({
        config: projectConfig.linear,
        projectId: projectConfig.linear.projectId,
        env,
        client,
      });
      const linearFeatures = await discoverLinearFeatures({
        resolvedConfig,
        client: new LinearGraphqlClient(projectConfig.linear.apiKey ?? ''),
      });
      const linearTickets = linearFeaturesToTicketRecords(linearFeatures);
      allTickets = [...allTickets, ...linearTickets];
      eligibleTickets = [...eligibleTickets, ...linearTickets];
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown Linear config error';
      const message = `Linear sync config failed.\nReason: ${reason}`;
      return {
        code: 1,
        message: isJson ? headlessJsonError(command, 'linear-config-failed', message) : message,
      };
    }
  }

  const eligibleFeatures = new Set(eligibleTickets.map((ticket) => ticket.feature));
  const unknownFeatures = featureSlugs.filter((slug) => !eligibleFeatures.has(slug));
  if (unknownFeatures.length > 0) {
    return headlessFailure(command, isJson, 'invalid-feature', `Invalid feature(s): ${unknownFeatures.join(', ')}`, {
      features: featureSlugs,
      unknownFeatures,
      eligibleFeatures: [...eligibleFeatures],
    });
  }

  let selectedTickets = eligibleTickets.filter((ticket) => featureSlugs.includes(ticket.feature));
  if (selectedTickets.length === 0) {
    return headlessFailure(
      command,
      isJson,
      'invalid-feature',
      `No eligible tickets found for selected feature(s): ${featureSlugs.join(', ')}`,
      {
        features: featureSlugs,
      },
    );
  }

  let runId: string = randomUUID();
  const activeRunControlPlane = new ActiveRunControlPlane({ repoRoot });
  const activeRun = activeRunControlPlane.acquireOrAttach(runId);
  if (activeRun.action === 'attached') {
    return headlessFailure(
      command,
      isJson,
      'active-run-exists',
      `Active AFK run already in progress: ${activeRun.record.runId}`,
      {
        runId: activeRun.record.runId,
      },
    );
  }
  runId = activeRun.record.runId;
  activeRunControlPlane.transition(runId, 'running');

  const harness = implValidation.harness;
  const model = implValidation.model;
  const reviewerHarness = reviewerValidation.harness;
  const reviewerModel = reviewerValidation.model;
  const reviewerPrompt = resolveReviewerPromptTemplate();

  let launchTickets = [...allTickets];
  selectedTickets = expandSelectedFeaturesToAllTickets(selectedTickets, launchTickets);
  selectedTickets = materializeLinearTicketMirrors(repoRoot, selectedTickets);
  launchTickets = launchTickets.map(
    (ticket) => selectedTickets.find((selected) => selected.label === ticket.label) ?? ticket,
  );

  const selectedFeatures = [...new Set(selectedTickets.map((ticket) => ticket.feature))];

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
    const metadataError = formatTicketMetadataError(error);
    return {
      code: 1,
      message: isJson ? headlessJsonError(command, 'ticket-metadata-error', metadataError) : metadataError,
    };
  }

  const orderingBlock = validateSelectedTicketDependencies(selectedTickets, launchTickets);
  if (orderingBlock) {
    return headlessFailure(command, isJson, 'invalid-ticket-dependencies', orderingBlock);
  }
  selectedTickets = orderSelectedTicketsByFeatureGraph(selectedTickets, featureGraphs);

  const localSelectedFeatures = selectedFeatures.filter((feature) => !selectedLinearFeatures.has(feature));
  const localWorkspaceGraph = localSelectedFeatures.length
    ? refreshWorkspaceExecutionGraph(repoRoot, localSelectedFeatures, concurrency)
    : null;
  const workspaceGraph = selectedLinearFeatures.size
    ? buildLinearWorkspaceGraph(selectedFeatures, selectedLinearFeatures, localWorkspaceGraph, concurrency)
    : (localWorkspaceGraph as WorkspaceExecutionGraph);
  const featureBlock = validateSelectedFeatureDependencies(workspaceGraph, selectedFeatures);
  if (featureBlock) {
    return headlessFailure(command, isJson, 'invalid-feature-dependencies', featureBlock);
  }

  const firstTicket = selectedTickets[0];
  if (!firstTicket) {
    return headlessFailure(command, isJson, 'invalid-feature', 'No tickets selected.');
  }
  const baseBranch = runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const checkoutFeatures = orderSelectedFeaturesByWaves(workspaceGraph);
  const worktreePreparationService = new WorktreePreparationService();
  let checkouts: ReturnType<WorktreePreparationService['prepare']>[];
  try {
    checkouts = checkoutFeatures.map((feature) => {
      const stackParent = workspaceGraph.features[feature]?.stackParent;
      const linearTicket = selectedTickets.find((ticket) => ticket.feature === feature && ticket.source === 'linear');
      return worktreePreparationService.prepare({
        repoRoot,
        featureSlug: feature,
        linearIssueKey: linearTicket?.linear?.parentKey,
        linearIssueBranchName: linearTicket?.linear?.parentBranchName,
        baseRef: stackParent ? stackParent : undefined,
        selectedTicketPaths: selectedTickets
          .filter((ticket) => ticket.feature === feature && !isLinearTicket(ticket))
          .map((ticket) => ticket.path),
        projectConfig,
      });
    });
  } catch (error) {
    if (error instanceof WorktreeReadinessBlockedError) {
      return headlessFailure(
        command,
        isJson,
        'worktree-readiness-blocked',
        `Launch blocked by worktree readiness: ${error.message}`,
      );
    }
    throw error;
  }

  const checkoutsByFeature = Object.fromEntries(checkoutFeatures.map((feature, index) => [feature, checkouts[index]]));

  const featureDependencies = Object.fromEntries(
    selectedFeatures.map((feature) => [feature, workspaceGraph.features[feature]?.dependsOnFeatures ?? []]),
  );
  const checkout = checkoutsByFeature[firstTicket.feature];
  const plan = buildLaunchPlan(
    repoRoot,
    model,
    selectedTickets,
    checkout,
    { harness: reviewerHarness, model: reviewerModel, prompt: reviewerPrompt },
    checkoutsByFeature,
    featureDependencies,
    harness,
    sandboxMode,
  );
  writeRunPlan(repoRoot, runId, plan.tickets);

  if (runtime.inlineLaunch) {
    return headlessFailure(
      command,
      isJson,
      'inline-launch-unsupported',
      'Headless launch does not support inline execution.',
    );
  }

  const context: DaemonLaunchContext = {
    repoRoot,
    runId,
    plan,
    harness,
    reviewerHarness,
    concurrency,
    budgets: launchPreferences.budgets,
    mergeBackToBase,
    featureCompletionAction,
    sandcastleSandboxMode: sandboxMode,
    baseBranch,
  };
  const spawnDaemon = runtime.spawnDaemon ?? defaultSpawnDaemon;
  const handle = spawnDaemon(context);
  if (!handle.pid) {
    activeRunControlPlane.clear(runId);
    return headlessFailure(
      command,
      isJson,
      'daemon-start-failed',
      'Failed to start background daemon. Check permissions and disk space.',
    );
  }
  activeRunControlPlane.updatePid(runId, handle.pid);
  handle.unref();

  const data = {
    runId,
    harness,
    model: model.id,
    reviewerHarness,
    reviewerModel: reviewerModel.id,
    features: selectedFeatures,
    tickets: selectedTickets.map((ticket) => ticket.label),
    concurrency,
    sandboxMode,
    completionAction: featureCompletionAction,
    repoRoot: path.resolve(repoRoot),
    worktree: checkout.effectiveWorktreeName,
    branch: checkout.effectiveBranchName,
  };

  const message = [
    `Run ID: ${runId}`,
    `Selected model: ${plan.model.id}`,
    `Selected harness: ${harness}`,
    `Selected reviewer model: ${plan.reviewerModel?.id ?? 'unknown'}`,
    `Selected reviewer harness: ${reviewerHarness}`,
    `Selected sandbox: ${plan.sandboxMode ?? 'no-sandbox'}`,
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
  ].join('\n');

  return { code: 0, message: isJson ? headlessJsonEnvelope(command, data, 'Daemon started in background.') : message };
}
