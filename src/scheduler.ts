import type { SingleTicketRunner, SingleTicketRunResult } from './single-ticket-runner.js';
import type { AgentExecutionProgressCallback, LaunchBlockEvidence, LaunchPlan, TicketRecord } from './types.js';

export interface SchedulerTicketResult {
  ticket: TicketRecord;
  outcome: NonNullable<SingleTicketRunResult['outcome']>;
  message: string;
  runId?: string;
  launchBlock?: LaunchBlockEvidence;
}

export interface SchedulerRunResult {
  scheduled: boolean;
  message: string;
  ticketResults: SchedulerTicketResult[];
  launchBlocks?: LaunchBlockEvidence[];
}

export class Scheduler {
  constructor(
    private readonly runner: SingleTicketRunner,
    private readonly concurrencyLimit = 3,
  ) {}

  async launch(
    plan: LaunchPlan,
    options: { onProgress?: AgentExecutionProgressCallback; runId?: string } = {},
  ): Promise<SchedulerRunResult> {
    if (!plan.tickets.length) return { scheduled: false, message: 'No ticket available for launch', ticketResults: [] };

    const completedTickets = plan.tickets.filter((ticket) => isComplete(ticket.status));
    const pending = plan.tickets.filter((ticket) => !isComplete(ticket.status));
    const plannedTickets = new Set(plan.tickets.map((ticket) => ticketKey(ticket)));
    const running = new Set<Promise<void>>();
    const runningTickets = new Set<string>();
    const runningFeatures = new Set<string>();
    const completed = new Set(completedTickets.map((ticket) => ticketKey(ticket)));
    const completedFeatures = new Set<string>();
    for (const feature of new Set(plan.tickets.map((t) => t.feature))) {
      const featureTickets = plan.tickets.filter((t) => t.feature === feature);
      if (featureTickets.every((t) => completed.has(ticketKey(t)))) {
        completedFeatures.add(feature);
      }
    }
    const failed = new Set<string>();
    const failures: string[] = [];
    const ticketResults: SchedulerTicketResult[] = completedTickets.map((ticket) => ({
      ticket,
      outcome: 'completed',
      message: `Skipped ${ticket.label}: ticket already done`,
      runId: options.runId,
    }));
    const launchBlocks: LaunchBlockEvidence[] = [];
    let resolveIdle: (() => void) | null = null;
    const idle = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });

    const startNext = (): void => {
      while (running.size < this.concurrencyLimit) {
        const index = pending.findIndex((ticket) =>
          isReady(ticket, plannedTickets, completed, failed, runningTickets, runningFeatures, completedFeatures, plan.featureDependencies),
        );
        if (index === -1) {
          if (!running.size) resolveIdle?.();
          return;
        }

        const [ticket] = pending.splice(index, 1);
        if (!ticket) return;
        runningTickets.add(ticketKey(ticket));
        runningFeatures.add(ticket.feature);

        const checkout = plan.checkouts?.[ticket.feature] ?? plan.checkout;
        const run = this.runner
          .launch({ ...plan, checkout, tickets: [ticket] }, { onProgress: options.onProgress, runId: options.runId })
          .then((result) => {
            const outcome = result.outcome ?? (result.scheduled ? 'completed' : 'not-scheduled');
            ticketResults.push({
              ticket,
              outcome,
              message: result.message,
              runId: options.runId,
              launchBlock: result.launchBlock,
            });
            if (!result.scheduled || outcome === 'not-scheduled') {
              failed.add(ticketKey(ticket));
              failures.push(result.message);
              if (result.launchBlock) launchBlocks.push(result.launchBlock);
            } else if (outcome === 'completed') {
              completed.add(ticketKey(ticket));
              const featureTickets = plan.tickets.filter((t) => t.feature === ticket.feature);
              if (featureTickets.every((t) => completed.has(ticketKey(t)))) {
                completedFeatures.add(ticket.feature);
              }
            } else {
              failed.add(ticketKey(ticket));
              failures.push(result.message);
            }
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : `ticket failed: ${ticket.label}`;
            ticketResults.push({ ticket, outcome: 'failed', message, runId: options.runId });
            failed.add(ticketKey(ticket));
            failures.push(message);
          })
          .finally(() => {
            runningTickets.delete(ticketKey(ticket));
            runningFeatures.delete(ticket.feature);
            running.delete(run);
            startNext();
          });

        running.add(run);
      }
    };

    startNext();
    await idle;
    for (const ticket of pending) {
      const message = `Not scheduled because dependencies did not complete: ${ticket.label}`;
      ticketResults.push({
        ticket,
        outcome: 'not-scheduled',
        message,
        runId: options.runId,
      });
      failures.push(message);
    }

    return {
      scheduled: true,
      message: failures.length ? failures.join('\n') : `Scheduled ${plan.tickets.length} tickets`,
      ticketResults,
      launchBlocks: launchBlocks.length ? launchBlocks : undefined,
    };
  }
}

function ticketKey(ticket: TicketRecord): string {
  return `${ticket.feature}/${ticket.issueName}`;
}

function isComplete(status?: string): boolean {
  const normalized = status?.trim().toLowerCase();
  return normalized === 'done' || normalized === 'closed' || normalized === 'complete' || normalized === 'resolved';
}

function isReady(
  ticket: TicketRecord,
  plannedTickets: Set<string>,
  completed: Set<string>,
  failed: Set<string>,
  running: Set<string>,
  runningFeatures: Set<string>,
  completedFeatures: Set<string>,
  featureDependencies?: Record<string, string[]>,
): boolean {
  if (running.has(ticketKey(ticket))) return false;
  if (runningFeatures.has(ticket.feature)) return false;
  const deps = featureDependencies?.[ticket.feature] ?? [];
  if (!deps.every((dep) => completedFeatures.has(dep))) return false;
  return (ticket.dependsOn ?? []).every((dependency) => {
    const key = `${ticket.feature}/${dependency}`;
    if (!plannedTickets.has(key)) return true;
    return completed.has(key) && !failed.has(key);
  });
}
