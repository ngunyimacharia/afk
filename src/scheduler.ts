import type { AgentExecutionProgressCallback, LaunchPlan, TicketRecord } from './types.js';
import type { SingleTicketRunner } from './single-ticket-runner.js';

export interface SchedulerRunResult {
  scheduled: boolean;
  message: string;
}

export class Scheduler {
  constructor(private readonly runner: SingleTicketRunner, private readonly concurrencyLimit = 3) {}

  async launch(plan: LaunchPlan, options: { onProgress?: AgentExecutionProgressCallback } = {}): Promise<SchedulerRunResult> {
    if (!plan.tickets.length) return { scheduled: false, message: 'No ticket available for launch' };

    const pending = [...plan.tickets];
    const running = new Set<Promise<void>>();
    const runningTickets = new Set<string>();
    const completed = new Set(plan.tickets.filter((ticket) => isComplete(ticket.status)).map((ticket) => ticketKey(ticket)));
    const failed = new Set<string>();
    const failures: string[] = [];
    let resolveIdle: (() => void) | null = null;
    const idle = new Promise<void>((resolve) => { resolveIdle = resolve; });

    const startNext = (): void => {
      while (running.size < this.concurrencyLimit) {
        const index = pending.findIndex((ticket) => isReady(ticket, completed, failed, runningTickets));
        if (index === -1) {
          if (!running.size) resolveIdle?.();
          return;
        }

        const [ticket] = pending.splice(index, 1);
        if (!ticket) return;
        runningTickets.add(ticketKey(ticket));

        const checkout = plan.checkouts?.[ticket.feature] ?? plan.checkout;
        const run = this.runner.launch({ ...plan, checkout, tickets: [ticket] }, { onProgress: options.onProgress }).then((result) => {
          if (!result.scheduled) {
            failed.add(ticketKey(ticket));
            failures.push(result.message);
          } else {
            completed.add(ticketKey(ticket));
          }
        }).catch((error) => {
          failed.add(ticketKey(ticket));
          failures.push(error instanceof Error ? error.message : `ticket failed: ${ticket.label}`);
        }).finally(() => {
          runningTickets.delete(ticketKey(ticket));
          running.delete(run);
          startNext();
        });

        running.add(run);
      }
    };

    startNext();
    await idle;

    return {
      scheduled: true,
      message: failures.length ? failures.join('\n') : `Scheduled ${plan.tickets.length} tickets`,
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

function isReady(ticket: TicketRecord, completed: Set<string>, failed: Set<string>, running: Set<string>): boolean {
  if (running.has(ticketKey(ticket))) return false;
  return (ticket.dependsOn ?? []).every((dependency) => {
    const key = `${ticket.feature}/${dependency}`;
    return completed.has(key) && !failed.has(key);
  });
}
