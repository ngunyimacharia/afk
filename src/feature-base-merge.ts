import type { MergeBackCoordinator } from './merge-back-coordinator.js';
import type { AgentExecutionProgressCallback, CheckoutContext, LaunchModel, ReviewerPromptTemplate } from './types.js';
import { runGit } from './worktree-preparation-service.js';

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
  for (const feature of input.features) {
    const checkout = input.checkoutsByFeature[feature];
    if (!checkout) continue;
    const branchName = checkout.effectiveBranchName;
    const ticketLabel = `${feature}/base-merge`;

    if (branchName === input.baseBranch) {
      results.push({ feature, branchName, success: true, deletedBranch: false, deletedWorktree: false });
      continue;
    }

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
      break;
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
    if (!cleanup.success) break;
  }
  return results;
}

function cleanupMergedFeatureBranch(
  repoRoot: string,
  baseBranch: string,
  checkout: CheckoutContext,
): Omit<FeatureBaseMergeResult, 'feature' | 'branchName'> {
  const branchName = checkout.effectiveBranchName;
  try {
    runGit(repoRoot, ['merge-base', '--is-ancestor', branchName, baseBranch]);
  } catch {
    return {
      success: false,
      deletedBranch: false,
      deletedWorktree: false,
      reason: `merge proof failed: ${branchName} is not reachable from ${baseBranch}`,
    };
  }

  let deletedWorktree = false;
  let deletedBranch = false;
  const errors: string[] = [];
  try {
    runGit(repoRoot, ['worktree', 'remove', '-f', checkout.worktreePath]);
    deletedWorktree = true;
  } catch (error) {
    errors.push(`worktree delete failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    runGit(repoRoot, ['branch', '-d', branchName]);
    deletedBranch = true;
  } catch (error) {
    errors.push(`branch delete failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (errors.length > 0) {
    return {
      success: true,
      deletedBranch,
      deletedWorktree,
      warning: errors.join(' | '),
    };
  }

  return {
    success: true,
    deletedBranch: true,
    deletedWorktree: true,
  };
}
