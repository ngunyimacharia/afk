import path from 'node:path';
import { TicketRepository } from './ticket-repository.js';
import { buildLaunchPlan } from './launch-context-builder.js';
import { ModelSelector } from './model-selector.js';
import { SelectionService } from './selection-service.js';
import { WorktreePreparationService } from './worktree-preparation-service.js';
import { runSync } from './sync/runner.js';
import { RuntimeStore } from './runtime-store.js';
import { SingleTicketRunner } from './single-ticket-runner.js';
import { FakeAgentExecutionProvider } from './agent-execution-provider.js';

export async function runAfk(repoRoot = process.cwd()): Promise<{ code: number; message: string }> {
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
  await runner.launch(plan);
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
