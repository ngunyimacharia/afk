import { checkBranchWorktreesClean, removeWorktreesForBranch } from './cleanup.js';
import type { MergeBackCoordinator } from './merge-back-coordinator.js';
import type { SchedulerTicketResult } from './scheduler.js';
import type { AgentExecutionProgressCallback, CheckoutContext, LaunchModel, ReviewerPromptTemplate } from './types.js';
import { branchExists, runGit } from './worktree-preparation-service.js';

export function featuresWithAllTicketsCompleted(ticketResults: SchedulerTicketResult[], features: string[]): string[] {
  const resultsByFeature = new Map<string, SchedulerTicketResult[]>();
  for (const result of ticketResults) {
    const list = resultsByFeature.get(result.ticket.feature) ?? [];
    list.push(result);
    resultsByFeature.set(result.ticket.feature, list);
  }

  return features.filter((feature) => {
    const results = resultsByFeature.get(feature);
    return (
      results !== undefined &&
      results.length > 0 &&
      results.every((r) => r.outcome === 'completed' || r.outcome === 'handoff')
    );
  });
}

export class BaseMergeLock {
  private running = new Set<string>();
  private queues = new Map<string, Array<(release: () => void) => void>>();

  isHeld(repoRoot: string): boolean {
    return this.running.has(repoRoot);
  }

  async acquire(repoRoot: string): Promise<{ release: () => void; waited: boolean }> {
    if (!this.running.has(repoRoot)) {
      this.running.add(repoRoot);
      return { release: () => this.release(repoRoot), waited: false };
    }

    return new Promise((resolve) => {
      const queue = this.queues.get(repoRoot) ?? [];
      queue.push((release: () => void) => resolve({ release, waited: true }));
      this.queues.set(repoRoot, queue);
    });
  }

  private release(repoRoot: string): void {
    const queue = this.queues.get(repoRoot);
    const next = queue?.shift();
    if (next) {
      next(() => this.release(repoRoot));
    } else {
      this.running.delete(repoRoot);
      this.queues.delete(repoRoot);
    }
  }
}

const defaultBaseMergeLock = new BaseMergeLock();

export interface FeatureBaseMergeInput {
  repoRoot: string;
  baseBranch: string;
  features: string[];
  checkoutsByFeature: Record<string, CheckoutContext>;
  coordinator: MergeBackCoordinator;
  model: LaunchModel;
  reviewerModel?: LaunchModel;
  reviewerPrompt?: ReviewerPromptTemplate;
  onProgress?: AgentExecutionProgressCallback;
  baseMergeLock?: BaseMergeLock;
}

export interface FeatureBaseMergeResult {
  feature: string;
  branchName: string;
  success: boolean;
  deletedBranch: boolean;
  deletedWorktree: boolean;
  reason?: string;
  warning?: string;
}

export async function mergeCompletedFeaturesToBase(input: FeatureBaseMergeInput): Promise<FeatureBaseMergeResult[]> {
  const results: FeatureBaseMergeResult[] = [];
  const lock = input.baseMergeLock ?? defaultBaseMergeLock;
  for (const feature of input.features) {
    const checkout = input.checkoutsByFeature[feature];
    if (!checkout) continue;
    const branchName = checkout.effectiveBranchName;
    const ticketLabel = `${feature}/base-merge`;

    if (branchName === input.baseBranch) {
      results.push({ feature, branchName, success: true, deletedBranch: false, deletedWorktree: false });
      continue;
    }

    if (!branchExists(input.repoRoot, branchName)) {
      const reason = `feature branch ${branchName} does not exist; cannot merge into ${input.baseBranch}`;
      results.push({
        feature,
        branchName,
        success: false,
        deletedBranch: false,
        deletedWorktree: false,
        reason,
      });
      input.onProgress?.({
        ticketLabel,
        message: reason,
        kind: 'failure',
      });
      continue;
    }

    const { release, waited } = await lock.acquire(input.repoRoot);
    if (waited) {
      input.onProgress?.({
        ticketLabel,
        message: `waiting for another feature's base merge to finish before merging ${branchName} into ${input.baseBranch}`,
      });
    }
    try {
      input.onProgress?.({
        ticketLabel,
        message: `merging ${branchName} into ${input.baseBranch}`,
      });

      const merge = await input.coordinator.mergeFeatureBranchToBase({
        repoRoot: input.repoRoot,
        baseBranch: input.baseBranch,
        featureBranch: branchName,
        feature,
        model: input.model,
        reviewerModel: input.reviewerModel,
        reviewerPrompt: input.reviewerPrompt,
        onProgress: input.onProgress,
      });

      if (!merge.success) {
        results.push({
          feature,
          branchName,
          success: false,
          deletedBranch: false,
          deletedWorktree: false,
          reason: merge.reason,
        });
        input.onProgress?.({
          ticketLabel,
          message: `base merge failed for ${branchName}: ${merge.reason}`,
          kind: 'failure',
        });
        continue;
      }

      const cleanup = cleanupMergedFeatureBranch(input.repoRoot, input.baseBranch, checkout);
      results.push({ feature, branchName, ...cleanup });
      input.onProgress?.({
        ticketLabel,
        message:
          cleanup.success && !cleanup.warning
            ? `merged ${branchName} into ${input.baseBranch} and cleaned up feature branch`
            : cleanup.warning
              ? `merged ${branchName} into ${input.baseBranch}; cleanup warning: ${cleanup.warning}`
              : `merged ${branchName} into ${input.baseBranch}; cleanup skipped: ${cleanup.reason ?? 'unknown error'}`,
        kind: cleanup.success ? 'message' : 'failure',
      });
      if (!cleanup.success) continue;
    } finally {
      release();
    }
  }
  return results;
}

function cleanupMergedFeatureBranch(
  repoRoot: string,
  baseBranch: string,
  checkout: CheckoutContext,
): Omit<FeatureBaseMergeResult, 'feature' | 'branchName'> {
  const branchName = checkout.effectiveBranchName;
  const warnings: string[] = [];
  try {
    runGit(repoRoot, ['merge-base', '--is-ancestor', branchName, baseBranch]);
  } catch {
    warnings.push(`merge proof failed: ${branchName} is not reachable from ${baseBranch}`);
  }

  const cleanWorktrees = checkBranchWorktreesClean(repoRoot, branchName);
  if (!cleanWorktrees.ok) {
    return { success: false, deletedBranch: false, deletedWorktree: false, reason: cleanWorktrees.reason };
  }

  const worktreeCleanup = removeWorktreesForBranch(repoRoot, branchName);
  if (!worktreeCleanup.success) {
    return {
      success: false,
      deletedBranch: false,
      deletedWorktree: worktreeCleanup.removedCount > 0,
      reason: worktreeCleanup.error,
    };
  }

  let deletedBranch = false;
  try {
    runGit(repoRoot, ['branch', '-d', branchName]);
    deletedBranch = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('not found')) {
      return {
        success: false,
        deletedBranch: false,
        deletedWorktree: worktreeCleanup.removedCount > 0,
        reason: `branch delete failed: ${message}`,
      };
    }
    warnings.push(`branch already deleted: ${branchName}`);
  }

  if (warnings.length > 0) {
    return {
      success: true,
      deletedBranch,
      deletedWorktree: worktreeCleanup.removedCount > 0,
      warning: warnings.join(' | '),
    };
  }

  return {
    success: true,
    deletedBranch,
    deletedWorktree: worktreeCleanup.removedCount > 0,
  };
}
