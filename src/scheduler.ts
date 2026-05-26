import type { ScratchWorktreeService } from './scratch-worktree-service.js';
import type { SingleTicketRunner, SingleTicketRunResult } from './single-ticket-runner.js';
import type { AgentExecutionProgressCallback, LaunchBlockEvidence, LaunchPlan, TicketRecord } from './types.js';

export interface FeatureLockProvider {
  isLocked(feature: string): boolean;
}

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

export interface SchedulerDependencies {
  runner: SingleTicketRunner;
  scratchWorktreeService: ScratchWorktreeService;
  featureLockProvider?: FeatureLockProvider;
  concurrencyLimit?: number;
}

export class Scheduler {
  constructor(private readonly deps: SchedulerDependencies) {}

  async launch(
    plan: LaunchPlan,
    options: { onProgress?: AgentExecutionProgressCallback; runId?: string } = {},
  ): Promise<SchedulerRunResult> {
    if (!plan.tickets.length) return { scheduled: false, message: 'No ticket available for launch', ticketResults: [] };

    const completedTickets = plan.tickets.filter((ticket) => isComplete(ticket.status));
    const pending = plan.tickets.filter((ticket) => !isComplete(ticket.status));
    const plannedTickets = new Set(plan.tickets.map((ticket) => ticketKey(ticket)));
    const plannedFeatures = new Set(plan.tickets.map((ticket) => ticket.feature));
    const running = new Set<Promise<void>>();
    const runningTickets = new Set<string>();
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

    const scratchWorktrees = new Map<string, ReturnType<ScratchWorktreeService['createScratchWorktree']>>();

    // Compute waves per feature using ALL planned tickets so dependency chains are correct.
    const featureWaves = new Map<string, Map<string, number>>();
    const featureWaveTickets = new Map<string, Map<number, string[]>>();
    const featureCompletedWave = new Map<string, number>();

    for (const feature of plannedFeatures) {
      const featureTickets = plan.tickets.filter((t) => t.feature === feature);
      const waves = computeWaves(featureTickets);
      featureWaves.set(feature, waves);

      const waveTickets = new Map<number, string[]>();
      for (const ticket of featureTickets) {
        const wave = waves.get(ticket.issueName) ?? 0;
        const arr = waveTickets.get(wave) ?? [];
        arr.push(ticketKey(ticket));
        waveTickets.set(wave, arr);
      }
      featureWaveTickets.set(feature, waveTickets);

      let highestCompleted = -1;
      for (let wave = 0; ; wave++) {
        const waveTicketKeys = waveTickets.get(wave);
        if (!waveTicketKeys) break;
        if (waveTicketKeys.every((key) => completed.has(key))) {
          highestCompleted = wave;
        } else {
          break;
        }
      }
      featureCompletedWave.set(feature, highestCompleted);
    }

    const startNext = (): void => {
      while (running.size < (this.deps.concurrencyLimit ?? 3)) {
        const index = pending.findIndex((ticket) =>
          isReady(
            ticket,
            plannedTickets,
            completed,
            failed,
            runningTickets,
            completedFeatures,
            plannedFeatures,
            featureWaves,
            featureCompletedWave,
            this.deps.featureLockProvider,
            plan.featureDependencies,
          ),
        );
        if (index === -1) {
          if (!running.size) resolveIdle?.();
          return;
        }

        const [ticket] = pending.splice(index, 1);
        if (!ticket) return;
        runningTickets.add(ticketKey(ticket));

        const scratchCheckout = this.deps.scratchWorktreeService.createScratchWorktree({
          repoRoot: plan.repoRoot,
          featureSlug: ticket.feature,
          issueName: ticket.issueName,
          baseRef: plan.checkouts?.[ticket.feature]?.effectiveBranchName ?? plan.checkout.effectiveBranchName,
        });
        scratchWorktrees.set(ticket.label, scratchCheckout);

        const checkout = scratchCheckout;
        const checkouts: LaunchPlan['checkouts'] = {
          ...plan.checkouts,
          ...Object.fromEntries(scratchWorktrees),
        };

        const run = this.deps.runner
          .launch({ ...plan, checkout, checkouts, tickets: [ticket] }, { onProgress: options.onProgress, runId: options.runId })
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
              // Update completed wave for this feature
              const ticketWave = featureWaves.get(ticket.feature)?.get(ticket.issueName) ?? 0;
              const waves = featureWaveTickets.get(ticket.feature);
              if (waves) {
                const waveTicketKeys = waves.get(ticketWave) ?? [];
                if (waveTicketKeys.every((key) => completed.has(key))) {
                  const currentCompleted = featureCompletedWave.get(ticket.feature) ?? -1;
                  if (ticketWave > currentCompleted) {
                    featureCompletedWave.set(ticket.feature, ticketWave);
                  }
                }
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

function computeWaves(tickets: TicketRecord[]): Map<string, number> {
  const byName = new Map(tickets.map((ticket) => [ticket.issueName, ticket] as const));
  const waves = new Map<string, number>();

  const compute = (issueName: string): number => {
    if (waves.has(issueName)) return waves.get(issueName)!;
    const ticket = byName.get(issueName);
    if (!ticket) return 0;
    const deps = (ticket.dependsOn ?? []).filter((dep) => byName.has(dep));
    if (deps.length === 0) {
      waves.set(issueName, 0);
      return 0;
    }
    const maxDepWave = Math.max(...deps.map((dep) => compute(dep)));
    const wave = maxDepWave + 1;
    waves.set(issueName, wave);
    return wave;
  };

  for (const [issueName] of byName) {
    compute(issueName);
  }

  return waves;
}

function isReady(
  ticket: TicketRecord,
  plannedTickets: Set<string>,
  completed: Set<string>,
  failed: Set<string>,
  running: Set<string>,
  completedFeatures: Set<string>,
  plannedFeatures: Set<string>,
  featureWaves: Map<string, Map<string, number>>,
  featureCompletedWave: Map<string, number>,
  featureLockProvider: FeatureLockProvider | undefined,
  featureDependencies?: Record<string, string[]>,
): boolean {
  if (running.has(ticketKey(ticket))) return false;
  if (featureLockProvider?.isLocked(ticket.feature)) return false;
  const deps = featureDependencies?.[ticket.feature] ?? [];
  for (const dep of deps) {
    if (plannedFeatures.has(dep) && !completedFeatures.has(dep)) return false;
  }
  // Wave boundary check: a ticket is ready only when all previous waves are fully completed.
  const ticketWave = featureWaves.get(ticket.feature)?.get(ticket.issueName) ?? 0;
  const highestCompletedWave = featureCompletedWave.get(ticket.feature) ?? -1;
  if (ticketWave > highestCompletedWave + 1) return false;
  return (ticket.dependsOn ?? []).every((dependency) => {
    const key = `${ticket.feature}/${dependency}`;
    if (!plannedTickets.has(key)) return true;
    return completed.has(key) && !failed.has(key);
  });
}
