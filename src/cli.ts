import path from 'node:path';
import { TicketRepository } from './ticket-repository.js';
import { buildLaunchPlan } from './launch-context-builder.js';
import { ModelSelector } from './model-selector.js';
import { SelectionService } from './selection-service.js';

export async function runAfk(repoRoot = process.cwd()): Promise<{ code: number; message: string }> {
  const repository = new TicketRepository(repoRoot);
  const tickets = repository.discoverTickets().filter((ticket) => repository.isEligible(ticket));
  if (!tickets.length) return { code: 0, message: 'No pending AFK tickets found' };
  const modelSelector = new ModelSelector(async () => [{ id: 'default-model' }], async (models) => models[0] ?? null);
  const selectionService = new SelectionService(async (items) => items);
  const model = await modelSelector.selectModel();
  const selectedTickets = await selectionService.selectTickets(tickets);
  if (!selectedTickets.length) return { code: 0, message: 'No tickets selected' };
  const plan = buildLaunchPlan(repoRoot, model, selectedTickets);
  return {
    code: 0,
    message: [
      `Selected model: ${plan.model.id}`,
      `Selected tickets (${plan.tickets.length}): ${plan.tickets.map((ticket) => ticket.label).join(', ')}`,
      `Repo root: ${path.resolve(plan.repoRoot)}`,
      `Recent git: ${plan.gitContext.commits.join(' | ')}`,
    ].join('\n'),
  };
}
