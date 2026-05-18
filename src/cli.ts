import path from 'node:path';
import { TicketRepository } from './ticket-repository.js';
import { buildLaunchPlan } from './launch-context-builder.js';
import { resolveLaunchModelSelection } from './launch-models.js';
import { resolveReviewerPrompt } from './reviewer-prompt-catalog.js';
import { SelectionService } from './selection-service.js';
import { WorktreePreparationService } from './worktree-preparation-service.js';
import { runSync } from './sync/runner.js';
import { RuntimeStore } from './runtime-store.js';
import { SingleTicketRunner } from './single-ticket-runner.js';
import { Scheduler } from './scheduler.js';
import { FakeAgentExecutionProvider } from './agent-execution-provider.js';
import { SummaryReporter } from './summary-reporter.js';
import { CleanupExecutor, CleanupPlanner } from './cleanup.js';
import type { ReviewTerminalOutcome } from './types.js';

function commandArg(): string | undefined {
  const command = process.argv[2];
  if (command === 'summary') return 'afk-summary';
  if (command === 'cleanup') return 'afk-cleanup';
  return command;
}

export async function runAfk(repoRoot = process.cwd()): Promise<{ code: number; message: string }> {
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
  const repository = new TicketRepository(repoRoot);
  const tickets = repository.discoverTickets().filter((ticket) => repository.isEligible(ticket));
  if (!tickets.length) return { code: 0, message: 'No pending AFK tickets found' };
  const selectionService = new SelectionService(async (items) => items);
  const worktreePreparationService = new WorktreePreparationService();
  const launchModels = resolveLaunchModelSelection({
    executionModelId: process.env.AFK_EXECUTION_MODEL?.trim() || process.env.AFK_MODEL?.trim(),
    reviewerModelId: process.env.AFK_REVIEWER_MODEL?.trim(),
  });
  const reviewerPrompt = resolveReviewerPrompt({
    repoRoot,
    override: process.env.AFK_REVIEWER_PROMPT?.trim() || undefined,
  });
  const selectedTickets = await selectionService.selectTickets(tickets);
  if (!selectedTickets.length) return { code: 0, message: 'No tickets selected' };
  const firstTicket = selectedTickets[0];
  const checkout = worktreePreparationService.prepare({ repoRoot, featureSlug: firstTicket.feature });
  const plan = buildLaunchPlan(repoRoot, launchModels.executionModel, launchModels.reviewerModel, reviewerPrompt, selectedTickets, checkout);
  const runtimeStore = new RuntimeStore({ repoRoot });
  const runner = new SingleTicketRunner(runtimeStore, new FakeAgentExecutionProvider({ status: 'completed', sessionId: 'session-1', removable: true, output: ['background worker scheduled'] }));
  const scheduler = new Scheduler(runner);
  await scheduler.launch(plan);
  const finalOutcome = readFinalReviewOutcome(runtimeStore, repoRoot, firstTicket.feature, firstTicket.issueName);
  return {
    code: 0,
    message: [
      `Reviewer model: ${plan.reviewerModel.id}`,
      `Final review outcome: ${finalOutcome}`,
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
