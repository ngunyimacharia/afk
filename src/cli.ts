import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type AgentExecutionProvider,
  ClaudeKimiAgentExecutionProvider,
  CompositeAgentExecutionProvider,
  OpenCodeAgentExecutionProvider,
} from './agent-execution-provider.js';
import { ClaudeCodeSessionExecutor, discoverClaudeKimiModels } from './claude-code.js';
import { CleanupExecutor, CleanupPlanner } from './cleanup.js';
import type { FeatureExecutionGraph } from './feature-execution-graph.js';
import { FeatureExecutionRefreshService } from './feature-execution-refresh.js';
import { isInteractiveLaunchAllowed, type PromptIO, runInteractiveLaunchWizard } from './interactive-launch.js';
import { buildLaunchPlan } from './launch-context-builder.js';
import { classifyProgressEvent, classifyRunOutcome, NotificationPolicy } from './notification-policy.js';
import type { OpenCodeSessionExecutor } from './opencode.js';
import { discoverOpenCodeModels, SDKOpenCodeSessionExecutor } from './opencode.js';
import { createLiveRunView } from './live-run-view.js';
import { OpenTUINotificationAdapter, type OpenTUIRenderer } from './opentui-notification-adapter.js';
import type { PermissionDecisionHistoryEntry } from './permission-coordinator.js';
import { PermissionCoordinator } from './permission-coordinator.js';
import { loadAfkProjectConfig } from './project-config.js';
import { classifyProviderFailure } from './provider-failure.js';
import { RuntimeStore } from './runtime-store.js';
import { Scheduler, type SchedulerTicketResult } from './scheduler.js';
import { SingleTicketRunner } from './single-ticket-runner.js';
import { SummaryReporter } from './summary-reporter.js';
import { runSync } from './sync/runner.js';
import { TicketRepository } from './ticket-repository.js';
import type { LaunchModel, TicketRecord } from './types.js';
import { orderSelectedFeaturesByWaves, refreshWorkspaceExecutionGraph } from './workspace-execution-graph.js';
import { WorktreePreparationService, WorktreeReadinessBlockedError } from './worktree-preparation-service.js';

function commandArg(): string | undefined {
  const knownCommands = new Set(['summary', 'cleanup', 'afk-summary', 'afk-cleanup', 'sync']);
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

export async function runAfk(
  repoRoot = process.cwd(),
  runtime: { io?: PromptIO; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; message: string }> {
  const io = runtime.io ?? { stdin: process.stdin, stdout: process.stdout };
  const env = runtime.env ?? process.env;
  const command = commandArg();
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
    const result = executor.execute(plan);
    return {
      code: 0,
      message: `${dryRun}\n\nExecuted:\n${result.deleted.map((item) => `- ${item}`).join('\n') || '- none'}`,
    };
  }
  if (command === 'sync') return runSync();
  const runtimeStore = new RuntimeStore({ repoRoot });
  const launchPreferences = runtimeStore.readLaunchPreferences();
  const projectConfig = loadAfkProjectConfig(repoRoot);
  if (!projectConfig.config) return { code: 1, message: projectConfig.errors.join('\n') };
  const interactivity = isInteractiveLaunchAllowed(io, env);
  if (!interactivity.ok)
    return { code: 1, message: interactivity.reason ?? 'AFK launch requires an interactive terminal.' };
  const activeProjectConfig = projectConfig.config;
  const repository = new TicketRepository(repoRoot);
  let allTickets: TicketRecord[];
  try {
    allTickets = repository.discoverTickets();
  } catch (error) {
    return { code: 1, message: formatTicketMetadataError(error) };
  }
  const tickets = allTickets.filter((ticket) => repository.isEligible(ticket));
  if (!tickets.length) return { code: 0, message: 'No pending AFK tickets found' };
  const worktreePreparationService = new WorktreePreparationService();
  let model: LaunchModel | undefined;
  let reviewerModel: LaunchModel | undefined;
  let reviewerPrompt: { id: string; label: string; path: string } | undefined;
  let selectedTickets: TicketRecord[] = [];
  let concurrency = 3;
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
    runtimeStore.writeLaunchPreferences({
      harness: wizard.harness,
      modelId: model?.id,
      reviewerHarness: wizard.reviewerHarness,
      reviewerModelId: reviewerModel?.id,
      concurrency,
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
  selectedTickets = expandSelectedFeaturesToAllTickets(selectedTickets, allTickets);
  const refresh = new FeatureExecutionRefreshService(repoRoot);
  let featureGraphs: Record<string, FeatureExecutionGraph>;
  try {
    featureGraphs = Object.fromEntries(selectedFeatures.map((feature) => [feature, refresh.refresh(feature)]));
  } catch (error) {
    return { code: 1, message: formatTicketMetadataError(error) };
  }
  const orderingBlock = validateSelectedTicketDependencies(selectedTickets, allTickets);
  if (orderingBlock) return { code: 1, message: orderingBlock };
  selectedTickets = orderSelectedTicketsByFeatureGraph(selectedTickets, featureGraphs);
  const workspaceGraph = refreshWorkspaceExecutionGraph(repoRoot, selectedFeatures, concurrency);
  const firstTicket = selectedTickets[0];
  for (const feature of selectedFeatures) {
    if ((workspaceGraph.features[feature]?.dependsOnFeatures.length ?? 0) > 1) {
      return {
        code: 1,
        message: `Fan-in branch automation deferred for ${feature}: multiple Depends-On-Features entries are not supported for automatic stacked branch preparation.`,
      };
    }
  }
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
          .filter((ticket) => ticket.feature === feature)
          .map((ticket) => ticket.path),
        projectConfig: activeProjectConfig,
      });
    });
  } catch (error) {
    if (error instanceof WorktreeReadinessBlockedError)
      return { code: 1, message: `Launch blocked by worktree readiness: ${error.message}` };
    throw error;
  }
  const checkoutsByFeature = Object.fromEntries(checkoutFeatures.map((feature, index) => [feature, checkouts[index]]));
  const checkout = checkoutsByFeature[firstTicket.feature];
  const plan = buildLaunchPlan(
    repoRoot,
    model,
    selectedTickets,
    checkout,
    { harness: reviewerHarness, model: reviewerModel, prompt: reviewerPrompt },
    checkoutsByFeature,
  );
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
  const scheduler = new Scheduler(runner, concurrency);
  const runId = randomUUID();
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
  });
  const progressLine = 'updateNotificationState' in view
    ? (view as unknown as { updateNotificationState(state: unknown): void })
    : null;
  if (progressLine) {
    progressLine.updateNotificationState({
      capability: renderer.capabilities.notifications ? 'supported' : 'unsupported',
    });
  }
  let schedulerResult: Awaited<ReturnType<Scheduler['launch']>>;
  try {
    schedulerResult = await scheduler.launch(plan, {
      onProgress: (event) => {
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
      },
      runId,
    });
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
  } finally {
    view.done();
  }
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
      ...formatManualPermissionReviewLines(permissionCoordinator.history),
    ].join('\n'),
  };
}

function formatTicketMetadataError(error: unknown): string {
  const reason = error instanceof Error ? error.message : 'Unknown ticket metadata error';
  return [
    'Launch blocked by invalid ticket metadata.',
    reason,
    'Fix: use opening YAML frontmatter with `status`, `Depends-On`, and PRD `Depends-On-Features` as needed.',
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
    const classification = classifyProviderFailure(line);
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
