import type { ScratchWorktreeService } from './scratch-worktree-service.js';
import type { SingleTicketRunner, SingleTicketRunResult } from './single-ticket-runner.js';
import type { AgentExecutionProgressCallback, LaunchBlockEvidence, LaunchPlan, TicketRecord } from './types.js';

export interface FeatureLockProvider {
  isLocked(feature: string): boolean;
}

export interface FeatureMergeBackProvider {
  isWaveMerged(feature: string, wave: number, issueNames: string[]): boolean;
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
  featureMergeBackProvider?: FeatureMergeBackProvider;
  onWaveComplete?: (feature: string, wave: number, issueNames: string[]) => Promise<void>;
  concurrencyLimit?: number;
}

export class Scheduler {
  constructor(private readonly deps: SchedulerDependencies) {}

  async launch(
    plan: LaunchPlan,
    options: { onProgress?: AgentExecutionProgressCallback; runId?: string } = {},
  ): Promise<SchedulerRunResult> {
    if (!plan.tickets.length) return { scheduled: false, message: 'No ticket available for launch', ticketResults: [] };

    const plannedTickets = new Set(plan.tickets.map((ticket) => ticketKey(ticket)));
    const plannedFeatures = new Set(plan.tickets.map((ticket) => ticket.feature));
    const running = new Set<Promise<void>>();
    const runningTickets = new Set<string>();
    const failed = new Set<string>();
    const failures: string[] = [];
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
    const featureMergedWave = new Map<string, number>();

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
    }

    const shouldResumeCompletedTicket = (ticket: TicketRecord): boolean => {
      if (!isComplete(ticket.status) || !this.deps.featureMergeBackProvider) return false;
      const ticketWave = featureWaves.get(ticket.feature)?.get(ticket.issueName) ?? 0;
      const waveTicketKeys = featureWaveTickets.get(ticket.feature)?.get(ticketWave) ?? [];
      if (waveTicketKeys.length === 0) return false;
      const laterIncompleteTicketExists = plan.tickets.some(
        (candidate) =>
          candidate.feature === ticket.feature &&
          !isComplete(candidate.status) &&
          (featureWaves.get(candidate.feature)?.get(candidate.issueName) ?? 0) > ticketWave,
      );
      if (!laterIncompleteTicketExists) return false;
      const issueNames = waveTicketKeys.map(issueNameFromTicketKey);
      return !this.deps.featureMergeBackProvider.isWaveMerged(ticket.feature, ticketWave, issueNames);
    };

    const completedTickets = plan.tickets.filter(
      (ticket) => isComplete(ticket.status) && !shouldResumeCompletedTicket(ticket),
    );
    const pending = plan.tickets.filter((ticket) => !isComplete(ticket.status) || shouldResumeCompletedTicket(ticket));
    const completed = new Set(completedTickets.map((ticket) => ticketKey(ticket)));
    const completedFeatures = new Set<string>();
    for (const feature of new Set(plan.tickets.map((t) => t.feature))) {
      const featureTickets = plan.tickets.filter((t) => t.feature === feature);
      if (featureTickets.every((t) => completed.has(ticketKey(t)))) {
        completedFeatures.add(feature);
      }
    }
    const ticketResults: SchedulerTicketResult[] = completedTickets.map((ticket) => ({
      ticket,
      outcome: 'completed',
      message: `Skipped ${ticket.label}: ticket already done`,
      runId: options.runId,
    }));

    for (const feature of plannedFeatures) {
      const waveTickets = featureWaveTickets.get(feature);
      if (!waveTickets) continue;
      let highestCompleted = -1;
      let highestMerged = -1;
      for (let wave = 0; ; wave++) {
        const waveTicketKeys = waveTickets.get(wave);
        if (!waveTicketKeys) break;
        if (waveTicketKeys.every((key) => completed.has(key))) {
          highestCompleted = wave;
          if (this.deps.featureMergeBackProvider) {
            const issueNames = waveTicketKeys.map(issueNameFromTicketKey);
            if (this.deps.featureMergeBackProvider.isWaveMerged(feature, wave, issueNames)) {
              highestMerged = wave;
            } else {
              break;
            }
          } else {
            highestMerged = wave;
          }
        } else {
          break;
        }
      }
      featureCompletedWave.set(feature, highestCompleted);
      featureMergedWave.set(feature, highestMerged);
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
            featureWaveTickets,
            featureMergedWave,
            this.deps.featureMergeBackProvider,
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
        const snapshot = plan.snapshots?.[ticket.label];
        const snapshots: LaunchPlan['snapshots'] = snapshot
          ? {
              ...plan.snapshots,
              [ticket.label]: {
                ...snapshot,
                worktreePath: scratchCheckout.worktreePath,
                worktreeName: scratchCheckout.effectiveWorktreeName,
                branchName: scratchCheckout.effectiveBranchName,
              },
            }
          : plan.snapshots;

        const run = this.deps.runner
          .launch(
            { ...plan, checkout, checkouts, snapshots, tickets: [ticket] },
            { onProgress: options.onProgress, runId: options.runId },
          )
          .then(async (result) => {
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
                  // Trigger merge-back when a wave completes
                  if (this.deps.onWaveComplete) {
                    const issueNames = waveTicketKeys.map(issueNameFromTicketKey);
                    await this.deps.onWaveComplete(ticket.feature, ticketWave, issueNames);
                  }
                  // Update merged wave if provider acknowledges merge-back
                  if (this.deps.featureMergeBackProvider) {
                    const issueNames = waveTicketKeys.map(issueNameFromTicketKey);
                    if (this.deps.featureMergeBackProvider.isWaveMerged(ticket.feature, ticketWave, issueNames)) {
                      const currentMerged = featureMergedWave.get(ticket.feature) ?? -1;
                      if (ticketWave > currentMerged) {
                        featureMergedWave.set(ticket.feature, ticketWave);
                      }
                    }
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
      const message = `Not scheduled because dependencies did not complete: ${ticket.label} - ${notReadyReason(
        ticket,
        plannedTickets,
        completed,
        failed,
        runningTickets,
        completedFeatures,
        plannedFeatures,
        featureWaves,
        featureWaveTickets,
        featureMergedWave,
        this.deps.featureMergeBackProvider,
        this.deps.featureLockProvider,
        plan.featureDependencies,
      )}`;
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

function issueNameFromTicketKey(key: string): string {
  return key.slice(key.indexOf('/') + 1);
}

function isComplete(status?: string): boolean {
  const normalized = status?.trim().toLowerCase();
  return normalized === 'done' || normalized === 'closed' || normalized === 'complete' || normalized === 'resolved';
}

function computeWaves(tickets: TicketRecord[]): Map<string, number> {
  const byName = new Map(tickets.map((ticket) => [ticket.issueName, ticket] as const));
  const waves = new Map<string, number>();

  const compute = (issueName: string): number => {
    const cachedWave = waves.get(issueName);
    if (cachedWave !== undefined) return cachedWave;
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
  featureWaveTickets: Map<string, Map<number, string[]>>,
  featureMergedWave: Map<string, number>,
  featureMergeBackProvider: FeatureMergeBackProvider | undefined,
  featureLockProvider: FeatureLockProvider | undefined,
  featureDependencies?: Record<string, string[]>,
): boolean {
  if (running.has(ticketKey(ticket))) return false;
  if (featureLockProvider?.isLocked(ticket.feature)) return false;
  const deps = featureDependencies?.[ticket.feature] ?? [];
  for (const dep of deps) {
    if (plannedFeatures.has(dep) && !completedFeatures.has(dep)) return false;
  }
  // Wave boundary check: a ticket is ready only when all previous waves are fully merged back.
  const ticketWave = featureWaves.get(ticket.feature)?.get(ticket.issueName) ?? 0;
  let highestMergedWave = featureMergedWave.get(ticket.feature) ?? -1;
  // Re-query merge state if the cached value might be stale (merge-back may have completed after wave finished)
  if (ticketWave > highestMergedWave + 1 && featureMergeBackProvider) {
    const waves = featureWaveTickets.get(ticket.feature);
    if (waves) {
      for (let wave = highestMergedWave + 1; wave < ticketWave; wave++) {
        const waveTicketKeys = waves.get(wave) ?? [];
        if (waveTicketKeys.every((key) => completed.has(key))) {
          const issueNames = waveTicketKeys.map(issueNameFromTicketKey);
          if (featureMergeBackProvider.isWaveMerged(ticket.feature, wave, issueNames)) {
            highestMergedWave = wave;
            featureMergedWave.set(ticket.feature, wave);
          } else {
            break;
          }
        } else {
          break;
        }
      }
    }
  }
  if (ticketWave > highestMergedWave + 1) return false;
  return (ticket.dependsOn ?? []).every((dependency) => {
    const key = `${ticket.feature}/${dependency}`;
    if (!plannedTickets.has(key)) return true;
    return completed.has(key) && !failed.has(key);
  });
}

function notReadyReason(
  ticket: TicketRecord,
  plannedTickets: Set<string>,
  completed: Set<string>,
  failed: Set<string>,
  running: Set<string>,
  completedFeatures: Set<string>,
  plannedFeatures: Set<string>,
  featureWaves: Map<string, Map<string, number>>,
  featureWaveTickets: Map<string, Map<number, string[]>>,
  featureMergedWave: Map<string, number>,
  featureMergeBackProvider: FeatureMergeBackProvider | undefined,
  featureLockProvider: FeatureLockProvider | undefined,
  featureDependencies?: Record<string, string[]>,
): string {
  if (running.has(ticketKey(ticket))) return 'ticket is already running';
  if (featureLockProvider?.isLocked(ticket.feature)) return `feature is locked: ${ticket.feature}`;

  const blockedFeatures = (featureDependencies?.[ticket.feature] ?? []).filter(
    (dep) => plannedFeatures.has(dep) && !completedFeatures.has(dep),
  );
  if (blockedFeatures.length) return `feature waits on incomplete feature dependencies: ${blockedFeatures.join(', ')}`;

  const ticketWave = featureWaves.get(ticket.feature)?.get(ticket.issueName) ?? 0;
  let highestMergedWave = featureMergedWave.get(ticket.feature) ?? -1;
  if (ticketWave > highestMergedWave + 1 && featureMergeBackProvider) {
    const waves = featureWaveTickets.get(ticket.feature);
    if (waves) {
      for (let wave = highestMergedWave + 1; wave < ticketWave; wave++) {
        const waveTicketKeys = waves.get(wave) ?? [];
        if (waveTicketKeys.every((key) => completed.has(key))) {
          const issueNames = waveTicketKeys.map(issueNameFromTicketKey);
          if (featureMergeBackProvider.isWaveMerged(ticket.feature, wave, issueNames)) {
            highestMergedWave = wave;
            featureMergedWave.set(ticket.feature, wave);
          } else {
            return `wave ${wave} for feature ${ticket.feature} is complete but not merged back`;
          }
        } else {
          const incomplete = waveTicketKeys.filter((key) => !completed.has(key)).map(issueNameFromTicketKey);
          return `waiting for earlier wave ${wave} tickets to complete: ${incomplete.join(', ')}`;
        }
      }
    }
  }
  if (ticketWave > highestMergedWave + 1) {
    return `waiting for previous wave merge-back (ticket wave ${ticketWave}, merged wave ${highestMergedWave})`;
  }

  const blockedDeps = (ticket.dependsOn ?? []).filter((dependency) => {
    const key = `${ticket.feature}/${dependency}`;
    if (!plannedTickets.has(key)) return false;
    return !completed.has(key) || failed.has(key);
  });
  if (blockedDeps.length) return `waiting on ticket dependencies: ${blockedDeps.join(', ')}`;

  return 'blocked by scheduler readiness constraints';
}
