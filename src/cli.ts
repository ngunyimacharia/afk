import path from 'node:path';
import { TicketRepository } from './ticket-repository.js';
import { buildLaunchPlan } from './launch-context-builder.js';
import { WorktreePreparationService } from './worktree-preparation-service.js';
import { runSync } from './sync/runner.js';
import { RuntimeStore } from './runtime-store.js';
import { SingleTicketRunner } from './single-ticket-runner.js';
import { Scheduler } from './scheduler.js';
import { OpenCodeAgentExecutionProvider } from './agent-execution-provider.js';
import { SummaryReporter } from './summary-reporter.js';
import { CleanupExecutor, CleanupPlanner } from './cleanup.js';
import { discoverOpenCodeModels, SDKOpenCodeSessionExecutor } from './opencode.js';
import { isInteractiveLaunchAllowed, runInteractiveLaunchWizard, type PromptIO } from './interactive-launch.js';
import { createProgressLine } from './progress-line.js';
import { FeatureExecutionRefreshService } from './feature-execution-refresh.js';
import { refreshWorkspaceExecutionGraph } from './workspace-execution-graph.js';
import type { LaunchModel, ReviewTerminalOutcome, TicketRecord } from './types.js';

function commandArg(): string | undefined {
  const command = process.argv[2];
  if (command === 'summary') return 'afk-summary';
  if (command === 'cleanup') return 'afk-cleanup';
  return command;
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
    const planner = new CleanupPlanner({ repoRoot });
    const plan = planner.buildPlan();
    const logTargets = plan.terminalTargets.flatMap((target) => [target.logPath, target.metadataPath]).filter(Boolean) as string[];
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
      ...(plan.featureDirectoriesToDelete.length ? plan.featureDirectoriesToDelete.map((featureDir) => `- ${featureDir}`) : ['- none']),
      '',
      'Run `afk-cleanup` again with the exact phrase `confirm cleanup plan` to execute this plan.',
    ].join('\n');
    if (process.argv.includes('confirm cleanup plan')) {
      const executor = new CleanupExecutor();
      const result = executor.execute(plan);
      return { code: 0, message: `${dryRun}\n\nExecuted:\n${result.deleted.map((item) => `- ${item}`).join('\n') || '- none'}` };
    }
    return { code: 0, message: dryRun };
  }
  if (command === 'sync') return runSync();
  const interactivity = isInteractiveLaunchAllowed(io, env);
  if (!interactivity.ok) return { code: 1, message: interactivity.reason ?? 'AFK launch requires an interactive terminal.' };
  const repository = new TicketRepository(repoRoot);
  const tickets = repository.discoverTickets().filter((ticket) => repository.isEligible(ticket));
  if (!tickets.length) return { code: 0, message: 'No pending AFK tickets found' };
  const worktreePreparationService = new WorktreePreparationService();
  const runtimeStore = new RuntimeStore({ repoRoot });
  let model: LaunchModel | undefined;
  let reviewerModel: LaunchModel | undefined;
  let reviewerPrompt: { id: string; label: string; path: string } | undefined;
  let selectedTickets: TicketRecord[] = [];
  let concurrency = 3;
  try {
    const models = await discoverOpenCodeModels();
    if (!models.length) {
      return {
        code: 0,
        message: 'No OpenCode models available. Configure models in OpenCode and run `afk` again.',
      };
    }
    const wizard = await runInteractiveLaunchWizard({ io, repoRoot, models, tickets, preferences: runtimeStore.readLaunchPreferences() });
    if (wizard.cancelled) return { code: 0, message: 'Launch cancelled' };
    model = wizard.model;
    reviewerModel = wizard.reviewerModel;
    reviewerPrompt = wizard.reviewerPrompt;
    selectedTickets = wizard.tickets ?? [];
    concurrency = wizard.concurrency ?? concurrency;
    runtimeStore.writeLaunchPreferences({ harness: wizard.harness, modelId: model?.id, reviewerModelId: reviewerModel?.id, concurrency });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown OpenCode discovery error';
    return {
      code: 0,
      message: `OpenCode model discovery failed. Configure OpenCode and retry.\nReason: ${reason}`,
    };
  }
  if (!model) return { code: 0, message: 'Launch cancelled' };
  if (!reviewerModel || !reviewerPrompt) return { code: 0, message: 'Launch cancelled' };
  if (!selectedTickets.length) return { code: 0, message: 'No tickets selected' };
  const selectedFeatures = [...new Set(selectedTickets.map((ticket) => ticket.feature))];
  const refresh = new FeatureExecutionRefreshService(repoRoot);
  for (const feature of selectedFeatures) refresh.refresh(feature);
  const workspaceGraph = refreshWorkspaceExecutionGraph(repoRoot, selectedFeatures, concurrency);
  const firstTicket = selectedTickets[0];
  for (const feature of selectedFeatures) {
    if ((workspaceGraph.features[feature]?.dependsOnFeatures.length ?? 0) > 1) {
      return { code: 1, message: `Fan-in branch automation deferred for ${feature}: multiple Depends-On-Features entries are not supported for automatic stacked branch preparation.` };
    }
  }
  const checkouts = Object.fromEntries(selectedFeatures.map((feature) => {
    const stackParent = workspaceGraph.features[feature]?.stackParent;
    return [feature, worktreePreparationService.prepare({ repoRoot, featureSlug: feature, baseRef: stackParent ? `afk/${stackParent}` : undefined })];
  }));
  const checkout = checkouts[firstTicket.feature];
  const plan = buildLaunchPlan(repoRoot, model, selectedTickets, checkout, { model: reviewerModel, prompt: reviewerPrompt });
  plan.checkouts = checkouts;
  const runner = new SingleTicketRunner(runtimeStore, new OpenCodeAgentExecutionProvider(new SDKOpenCodeSessionExecutor()));
  const scheduler = new Scheduler(runner, concurrency);
  const progressLine = createProgressLine(io.stdout);
  try {
    await scheduler.launch(plan, { onProgress: (event) => progressLine.update(event) });
  } finally {
    progressLine.done();
  }
  return {
    code: 0,
    message: [
      `Selected model: ${plan.model.id}`,
      `Selected reviewer model: ${plan.reviewerModel?.id ?? 'unknown'}`,
      `Reviewer prompt: ${plan.reviewerPrompt?.id ?? 'unknown'}`,
      `Selected tickets (${plan.tickets.length}): ${plan.tickets.map((ticket) => ticket.label).join(', ')}`,
      `Selected features (${selectedFeatures.length}): ${selectedFeatures.join(', ')}`,
      `Concurrency: ${concurrency}`,
      `Repo root: ${path.resolve(plan.repoRoot)}`,
      `Worktree: ${plan.checkout.effectiveWorktreeName}`,
      `Branch: ${plan.checkout.effectiveBranchName}`,
      `Recent git: ${plan.gitContext.commits.join(' | ')}`,
      `Final review outcome: ${readFinalReviewOutcome(runtimeStore, repoRoot, firstTicket.feature, firstTicket.issueName)}`,
    ].join('\n'),
  };
}

function readFinalReviewOutcome(runtimeStore: RuntimeStore, repoRoot: string, featureSlug: string, issueName: string): ReviewTerminalOutcome {
  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', `${featureSlug}-${issueName}.json`);

  try {
    const metadata = runtimeStore.readMetadata(metadataPath);
    if (metadata.FINAL_REVIEW_OUTCOME === 'approved' || metadata.FINAL_REVIEW_OUTCOME === 'needs-human') {
      return metadata.FINAL_REVIEW_OUTCOME;
    }
    if (metadata.STATUS === 'blocked' || metadata.STATUS === 'failed' || metadata.STATUS === 'interrupted') return 'needs-human';
    if (metadata.STATUS === 'completed') return 'approved';
  } catch {
    return 'needs-human';
  }

  return 'needs-human';
}
