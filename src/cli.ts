import path from 'node:path';
import { TicketRepository } from './ticket-repository.js';
import { buildLaunchPlan } from './launch-context-builder.js';
import { ModelSelector } from './model-selector.js';
import { SelectionService } from './selection-service.js';
import { WorktreePreparationService } from './worktree-preparation-service.js';
import { runSync } from './sync/runner.js';
import { RuntimeStore } from './runtime-store.js';
import { SingleTicketRunner } from './single-ticket-runner.js';
import { Scheduler } from './scheduler.js';
import { FakeAgentExecutionProvider } from './agent-execution-provider.js';
import { SummaryReporter } from './summary-reporter.js';
import { CleanupExecutor, CleanupPlanner } from './cleanup.js';

export async function runAfk(repoRoot = process.cwd()): Promise<{ code: number; message: string }> {
  if (process.argv[2] === 'afk-summary') {
    const reporter = new SummaryReporter({ repoRoot });
    const report = await reporter.summarize();
    return { code: 0, message: report.message };
  }
  if (process.argv[2] === 'afk-cleanup') {
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
  if (process.argv[2] === 'sync') return runSync();
  const repository = new TicketRepository(repoRoot);
  const tickets = repository.discoverTickets().filter((ticket) => repository.isEligible(ticket));
  if (!tickets.length) return { code: 0, message: 'No pending AFK tickets found' };
  const modelSelector = new ModelSelector(async () => [{ id: 'default-model' }], async (models) => models[0] ?? null);
  const selectionService = new SelectionService(async (items) => items);
  const worktreePreparationService = new WorktreePreparationService();
  const model = await modelSelector.selectModel();
  const selectedTickets = await selectionService.selectTickets(tickets);
  if (!selectedTickets.length) return { code: 0, message: 'No tickets selected' };
  const firstTicket = selectedTickets[0];
  const checkout = worktreePreparationService.prepare({ repoRoot, featureSlug: firstTicket.feature });
  const plan = buildLaunchPlan(repoRoot, model, selectedTickets, checkout);
  const runtimeStore = new RuntimeStore({ repoRoot });
  const runner = new SingleTicketRunner(runtimeStore, new FakeAgentExecutionProvider({ status: 'completed', sessionId: 'session-1', removable: true, output: ['background worker scheduled'] }));
  const scheduler = new Scheduler(runner);
  await scheduler.launch(plan);
  return {
    code: 0,
    message: [
      `Selected model: ${plan.model.id}`,
      `Selected tickets (${plan.tickets.length}): ${plan.tickets.map((ticket) => ticket.label).join(', ')}`,
      `Repo root: ${path.resolve(plan.repoRoot)}`,
      `Worktree: ${plan.checkout.effectiveWorktreeName}`,
      `Branch: ${plan.checkout.effectiveBranchName}`,
      `Recent git: ${plan.gitContext.commits.join(' | ')}`,
    ].join('\n'),
  };
}
