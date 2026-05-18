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

    const grouped = this.groupByFeature(plan.tickets);
    const featureOrder = this.featureOrder(plan.tickets);
    const active = new Set<string>();
    const queues = new Map<string, TicketRecord[]>(grouped);
    const running = new Set<Promise<void>>();
    const failures: string[] = [];
    let resolveIdle: (() => void) | null = null;
    const idle = new Promise<void>((resolve) => { resolveIdle = resolve; });

    const startNext = (): void => {
      while (running.size < this.concurrencyLimit) {
        const nextFeature = featureOrder.find((feature) => !active.has(feature) && (queues.get(feature)?.length ?? 0) > 0);
        if (!nextFeature) {
          if (!running.size) resolveIdle?.();
          return;
        }

        const ticket = queues.get(nextFeature)?.shift();
        if (!ticket) return;
        active.add(nextFeature);

        const run = this.runner.launch({ ...plan, tickets: [ticket] }, { onProgress: options.onProgress }).then((result) => {
          if (!result.scheduled) failures.push(result.message);
        }).catch((error) => {
          failures.push(error instanceof Error ? error.message : `ticket failed: ${ticket.label}`);
        }).finally(() => {
          active.delete(nextFeature);
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

  private groupByFeature(tickets: TicketRecord[]): Map<string, TicketRecord[]> {
    const queues = new Map<string, TicketRecord[]>();
    for (const ticket of tickets) {
      const queue = queues.get(ticket.feature) ?? [];
      queue.push(ticket);
      queues.set(ticket.feature, queue);
    }
    return queues;
  }

  private featureOrder(tickets: TicketRecord[]): string[] {
    return [...new Set(tickets.map((ticket) => ticket.feature))];
  }
}
