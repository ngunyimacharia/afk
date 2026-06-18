import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentExecutionProvider, AgentInvocationMode } from './agent-execution-provider.js';
import { withBranchMergeLock } from './branch-merge-lock.js';
import { persistFailedPostMergeCleanupItem } from './cleanup.js';
import type { ReadinessCommandExecutor } from './readiness-service.js';
import { runReadinessCommands } from './readiness-service.js';
import { CONFLICT_RESOLUTION_PROMPT_ID, resolveReviewerPrompt } from './reviewer-prompt-catalog.js';
import type { RuntimeStore } from './runtime-store.js';
import type { FeatureLockProvider, FeatureMergeBackProvider } from './scheduler.js';
import type {
  AgentExecutionProgressCallback,
  AgentExecutionResult,
  CheckoutContext,
  LaunchModel,
  LaunchPlan,
  TicketRecord,
} from './types.js';
import { runGit } from './worktree-preparation-service.js';

const DEFAULT_CONFLICT_RESOLUTION_BUDGET = 50;

export interface MergeBackTicket {
  feature: string;
  issueName: string;
  branchName: string;
  worktreePath: string;
  dependsOn?: string[];
  metadataPath: string;
  logPath: string;
}

interface MergeBackCleanupInput {
  repoRoot: string;
  featureWorktreePath: string;
  featureBranchName: string;
  ticket: MergeBackTicket;
  mergedIssueTip: string;
}

export interface MergeWaveInput {
  repoRoot: string;
  feature: string;
  featureWorktreePath: string;
  featureBranchName: string;
  wave: number;
  tickets: MergeBackTicket[];
  model: LaunchModel;
  reviewerModel?: LaunchModel;
  reviewerPrompt?: { id: string; label: string; path: string; content?: string };
  onProgress?: AgentExecutionProgressCallback;
}

export interface MergeWaveResult {
  success: boolean;
  mergedTickets: string[];
  failedTickets: Array<{ issueName: string; reason: string; conflictPaths?: string[] }>;
  cleanupResults: MergeBackCleanupResult[];
}

export interface MergeBackCleanupResult {
  feature: string;
  issueName: string;
  branchName: string;
  worktreePath: string;
  featureWorktreePath: string;
  featureBranchName: string;
  mergedIssueTip: string;
  success: boolean;
  deletedBranch: boolean;
  deletedWorktree: boolean;
  warning?: string;
  error?: string;
}

export interface ResolveFeatureConflictsInput {
  repoRoot: string;
  feature: string;
  featureWorktreePath: string;
  featureBranchName: string;
  model: LaunchModel;
  reviewerModel?: LaunchModel;
  reviewerPrompt?: { id: string; label: string; path: string; content?: string };
  invocationMode?: AgentInvocationMode;
  onProgress?: AgentExecutionProgressCallback;
}

export interface ResolveFeatureConflictsResult {
  success: boolean;
  reason?: string;
  conflictPaths?: string[];
}

interface MergeConflictDiagnostics {
  conflictPaths: string[];
  statusShort: string;
  markersRemain: boolean;
  unmergedIndexPaths: string[];
  summary: string;
}

export interface MergeBackCoordinatorDependencies {
  agentExecutionProvider: AgentExecutionProvider;
  runtimeStore: RuntimeStore;
  readinessExecutor?: ReadinessCommandExecutor;
  conflictResolutionBudget?: number;
}

export class MergeBackCoordinator implements FeatureLockProvider, FeatureMergeBackProvider {
  private readonly lockedFeatures = new Set<string>();
  private readonly mergedWaves = new Map<string, Set<number>>();

  constructor(private readonly deps: MergeBackCoordinatorDependencies) {}

  isLocked(feature: string): boolean {
    return this.lockedFeatures.has(feature);
  }

  isWaveMerged(feature: string, wave: number, _issueNames: string[]): boolean {
    return this.mergedWaves.get(feature)?.has(wave) ?? false;
  }

  async mergeWave(input: MergeWaveInput): Promise<MergeWaveResult> {
    const { feature, tickets } = input;
    if (tickets.length === 0) {
      return { success: true, mergedTickets: [], failedTickets: [], cleanupResults: [] };
    }

    this.lockedFeatures.add(feature);
    try {
      return await withBranchMergeLock(input.repoRoot, input.featureBranchName, async () => {
        const { wave } = input;
        const sorted = sortTicketsByDependencies(tickets);
        const mergedTickets: string[] = [];
        const failedTickets: Array<{ issueName: string; reason: string; conflictPaths?: string[] }> = [];
        const cleanupResults: MergeBackCleanupResult[] = [];

        for (const ticket of sorted) {
          const result = await this.mergeSingleTicket(input, ticket);
          if (result.success) {
            mergedTickets.push(ticket.issueName);
            const cleanupResult = cleanupMergedIssueResources({
              repoRoot: input.repoRoot,
              featureWorktreePath: input.featureWorktreePath,
              featureBranchName: input.featureBranchName,
              ticket,
              mergedIssueTip: resolveBranchTip(input.featureWorktreePath, ticket.branchName),
            });
            cleanupResults.push(cleanupResult);
            if (!cleanupResult.success) {
              persistFailedPostMergeCleanupItem(input.repoRoot, {
                feature: cleanupResult.feature,
                issueName: cleanupResult.issueName,
                branchName: cleanupResult.branchName,
                worktreePath: cleanupResult.worktreePath,
                featureWorktreePath: cleanupResult.featureWorktreePath,
                featureBranchName: cleanupResult.featureBranchName,
                mergedIssueTip: cleanupResult.mergedIssueTip,
                warning: cleanupResult.warning,
                error: cleanupResult.error,
                failedAt: new Date().toISOString(),
              });
            }
            this.deps.runtimeStore.appendLog(
              ticket.logPath,
              JSON.stringify({
                event: 'post-merge-cleanup',
                issue: ticket.issueName,
                branch: ticket.branchName,
                worktreePath: ticket.worktreePath,
                status: cleanupResult.success ? 'success' : cleanupResult.error ? 'warning' : 'failed',
                deletedBranch: cleanupResult.deletedBranch,
                deletedWorktree: cleanupResult.deletedWorktree,
                warning: cleanupResult.warning ?? null,
                error: cleanupResult.error ?? null,
              }),
            );
            input.onProgress?.({
              ticketLabel: `${ticket.feature}/${ticket.issueName}`,
              message: cleanupResult.success
                ? `post-merge cleanup succeeded for ${ticket.branchName}`
                : cleanupResult.error
                  ? `post-merge cleanup warning for ${ticket.branchName}: ${cleanupResult.error}`
                  : `post-merge cleanup skipped for ${ticket.branchName}: ${cleanupResult.warning ?? 'unknown error'}`,
              kind: 'message',
            });
          } else {
            failedTickets.push({
              issueName: ticket.issueName,
              reason: result.reason,
              conflictPaths: result.conflictPaths,
            });
            break;
          }
        }

        const success = failedTickets.length === 0 && mergedTickets.length === tickets.length;
        if (success) {
          const featureWaves = this.mergedWaves.get(feature) ?? new Set<number>();
          featureWaves.add(wave);
          this.mergedWaves.set(feature, featureWaves);
        }

        return { success, mergedTickets, failedTickets, cleanupResults };
      });
    } finally {
      this.lockedFeatures.delete(feature);
    }
  }

  async mergeFeatureBranchToBase(input: {
    repoRoot: string;
    baseBranch: string;
    featureBranch: string;
    feature: string;
    model: LaunchModel;
    reviewerModel?: LaunchModel;
    reviewerPrompt?: { id: string; label: string; path: string; content?: string };
    onProgress?: AgentExecutionProgressCallback;
  }): Promise<{ success: boolean; reason: string; conflictPaths?: string[] }> {
    return withBranchMergeLock(input.repoRoot, input.baseBranch, async () => {
      const { repoRoot, baseBranch, featureBranch, feature } = input;

      const status = runGit(repoRoot, ['status', '--porcelain']);
      const hasChanges = status.trim().length > 0;
      let stashed = false;
      if (hasChanges) {
        try {
          runGit(repoRoot, ['stash', 'push', '-m', 'AFK auto-merge-back stash']);
          stashed = true;
        } catch {
          return { success: false, reason: 'Base branch has uncommitted changes and stash failed' };
        }
      }

      try {
        const currentBranch = runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
        if (currentBranch !== baseBranch) {
          try {
            runGit(repoRoot, ['checkout', baseBranch]);
          } catch (error) {
            const reason = error instanceof Error ? error.message : `Failed to checkout ${baseBranch}`;
            return { success: false, reason };
          }
        }

        const mergeResult = tryMerge(repoRoot, featureBranch);

        if (mergeResult.success) {
          return { success: true, reason: '' };
        }

        const budget = this.deps.conflictResolutionBudget ?? DEFAULT_CONFLICT_RESOLUTION_BUDGET;
        let finalDiagnostics = getMergeConflictDiagnostics(repoRoot);

        for (let attempt = 1; attempt <= budget; attempt++) {
          const diagnostics = getMergeConflictDiagnostics(repoRoot);
          finalDiagnostics = diagnostics;
          const ticket: MergeBackTicket = {
            feature,
            issueName: 'base-merge',
            branchName: featureBranch,
            worktreePath: repoRoot,
            metadataPath: '',
            logPath: '',
          };
          const prompt = buildConflictResolutionPrompt(ticket, diagnostics, attempt, budget);
          const agentResult = await this.invokeReviewerAgentForBaseMerge(input, prompt);

          if (agentResult.status === 'completed') {
            const remainingDiagnostics = getMergeConflictDiagnostics(repoRoot);
            finalDiagnostics = remainingDiagnostics;

            if (remainingDiagnostics.conflictPaths.length === 0 && !remainingDiagnostics.markersRemain) {
              const readiness = runReadinessCommands({
                cwd: repoRoot,
                executor: this.deps.readinessExecutor,
              });
              const failed = [...readiness.staticStyleChecks, readiness.smoke].find((r) => r.status === 'failed');
              if (!failed) {
                if (isMergeInProgress(repoRoot)) {
                  commitMerge(repoRoot, `Merge ${featureBranch} into ${baseBranch}`);
                }
                return { success: true, reason: '' };
              }

              if (attempt === budget) {
                abortMerge(repoRoot);
                return {
                  success: false,
                  reason: `Readiness checks failed after conflict resolution: ${failed.command}`,
                  conflictPaths: remainingDiagnostics.conflictPaths,
                };
              }
              continue;
            }

            if (attempt === budget) {
              abortMerge(repoRoot);
              return {
                success: false,
                reason: `Conflicts remain after ${budget} resolution attempts`,
                conflictPaths: remainingDiagnostics.conflictPaths,
              };
            }
            continue;
          }

          if (attempt === budget) {
            abortMerge(repoRoot);
            return {
              success: false,
              reason: `Reviewer agent failed to resolve conflicts after ${budget} attempts`,
              conflictPaths: finalDiagnostics.conflictPaths,
            };
          }
        }

        abortMerge(repoRoot);
        return { success: false, reason: 'Unexpected merge failure', conflictPaths: finalDiagnostics.conflictPaths };
      } finally {
        if (stashed) {
          try {
            runGit(repoRoot, ['stash', 'pop']);
          } catch {
            // Best effort
          }
        }
      }
    });
  }

  async resolveFeatureWorktreeConflicts(input: ResolveFeatureConflictsInput): Promise<ResolveFeatureConflictsResult> {
    const { featureWorktreePath } = input;

    if (!isMergeInProgress(featureWorktreePath)) {
      return { success: true };
    }

    const budget = this.deps.conflictResolutionBudget ?? DEFAULT_CONFLICT_RESOLUTION_BUDGET;
    const ticket: MergeBackTicket = {
      feature: input.feature,
      issueName: 'startup-conflict',
      branchName: input.featureBranchName,
      worktreePath: featureWorktreePath,
      metadataPath: '',
      logPath: '',
    };

    let finalDiagnostics = getMergeConflictDiagnostics(featureWorktreePath);

    for (let attempt = 1; attempt <= budget; attempt++) {
      const diagnostics = getMergeConflictDiagnostics(featureWorktreePath);
      finalDiagnostics = diagnostics;
      const prompt = buildConflictResolutionPrompt(ticket, diagnostics, attempt, budget);
      const agentResult = await this.invokeConflictResolutionAgent(input, ticket, prompt, 'execution');

      if (agentResult.status === 'completed') {
        const remainingDiagnostics = getMergeConflictDiagnostics(featureWorktreePath);
        finalDiagnostics = remainingDiagnostics;

        if (remainingDiagnostics.conflictPaths.length === 0 && !remainingDiagnostics.markersRemain) {
          const readiness = runReadinessCommands({
            cwd: featureWorktreePath,
            executor: this.deps.readinessExecutor,
          });
          const failed = [...readiness.staticStyleChecks, readiness.smoke].find((r) => r.status === 'failed');
          if (!failed) {
            if (isMergeInProgress(featureWorktreePath)) {
              commitMerge(featureWorktreePath, `Resolve merge conflicts for ${input.featureBranchName}`);
            }
            return { success: true };
          }

          if (attempt === budget) {
            abortMerge(featureWorktreePath);
            return {
              success: false,
              reason: `Readiness checks failed after conflict resolution: ${failed.command}`,
              conflictPaths: remainingDiagnostics.conflictPaths,
            };
          }
          continue;
        }

        if (attempt === budget) {
          abortMerge(featureWorktreePath);
          return {
            success: false,
            reason: `Conflicts remain after ${budget} resolution attempts`,
            conflictPaths: remainingDiagnostics.conflictPaths,
          };
        }
        continue;
      }

      if (attempt === budget) {
        abortMerge(featureWorktreePath);
        return {
          success: false,
          reason: `Reviewer agent failed to resolve conflicts after ${budget} attempts`,
          conflictPaths: finalDiagnostics.conflictPaths,
        };
      }
    }

    abortMerge(featureWorktreePath);
    return { success: false, reason: 'Unexpected merge failure', conflictPaths: finalDiagnostics.conflictPaths };
  }

  private async mergeSingleTicket(
    input: MergeWaveInput,
    ticket: MergeBackTicket,
  ): Promise<{ success: boolean; reason: string; conflictPaths?: string[] }> {
    try {
      discardWorktreeChanges(input.featureWorktreePath);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'Failed to discard feature worktree changes before merge-back';
      this.deps.runtimeStore.updateMetadata(ticket.metadataPath, {
        MERGE_STATUS: 'failed',
        MERGE_CONFLICT_PATHS: null,
        MERGE_FINAL_DIAGNOSTICS: null,
        MERGE_RESOLUTION_OUTPUT: null,
      });
      this.deps.runtimeStore.appendLog(
        ticket.logPath,
        JSON.stringify({ event: 'merge-back', status: 'failed', branch: ticket.branchName, reason }),
      );
      input.onProgress?.({ ticketLabel: `${ticket.feature}/${ticket.issueName}`, message: reason, kind: 'failure' });
      return { success: false, reason };
    }

    const mergeResult = tryMerge(input.featureWorktreePath, ticket.branchName);

    if (mergeResult.success) {
      this.deps.runtimeStore.updateMetadata(ticket.metadataPath, {
        MERGE_STATUS: 'merged',
        MERGE_CONFLICT_PATHS: null,
        MERGE_FINAL_DIAGNOSTICS: null,
        MERGE_RESOLUTION_OUTPUT: null,
      });
      this.deps.runtimeStore.appendLog(
        ticket.logPath,
        JSON.stringify({ event: 'merge-back', status: 'merged', branch: ticket.branchName }),
      );
      return { success: true, reason: '' };
    }

    const budget = this.deps.conflictResolutionBudget ?? DEFAULT_CONFLICT_RESOLUTION_BUDGET;
    let finalDiagnostics = getMergeConflictDiagnostics(input.featureWorktreePath);

    for (let attempt = 1; attempt <= budget; attempt++) {
      const diagnostics = getMergeConflictDiagnostics(input.featureWorktreePath);
      finalDiagnostics = diagnostics;
      const prompt = buildConflictResolutionPrompt(ticket, diagnostics, attempt, budget);
      const agentResult = await this.invokeReviewerAgent(input, ticket, prompt);

      if (agentResult.status === 'completed') {
        const remainingDiagnostics = getMergeConflictDiagnostics(input.featureWorktreePath);
        finalDiagnostics = remainingDiagnostics;

        if (remainingDiagnostics.conflictPaths.length === 0 && !remainingDiagnostics.markersRemain) {
          const readiness = runReadinessCommands({
            cwd: input.featureWorktreePath,
            executor: this.deps.readinessExecutor,
          });
          const failed = [...readiness.staticStyleChecks, readiness.smoke].find((r) => r.status === 'failed');
          if (!failed) {
            if (isMergeInProgress(input.featureWorktreePath)) {
              commitMerge(input.featureWorktreePath, `Merge ${ticket.branchName} (conflicts resolved)`);
            }
            this.deps.runtimeStore.updateMetadata(ticket.metadataPath, {
              MERGE_STATUS: 'conflict-resolved',
              MERGE_CONFLICT_PATHS: null,
              MERGE_FINAL_DIAGNOSTICS: null,
              MERGE_RESOLUTION_OUTPUT: null,
            });
            this.deps.runtimeStore.appendLog(
              ticket.logPath,
              JSON.stringify({
                event: 'merge-back',
                status: 'conflict-resolved',
                branch: ticket.branchName,
                attempts: attempt,
              }),
            );
            return { success: true, reason: '' };
          }

          if (attempt === budget) {
            abortMerge(input.featureWorktreePath);
            this.deps.runtimeStore.updateMetadata(ticket.metadataPath, {
              MERGE_STATUS: 'failed',
              MERGE_CONFLICT_PATHS: remainingDiagnostics.conflictPaths,
              MERGE_FINAL_DIAGNOSTICS: remainingDiagnostics,
              MERGE_RESOLUTION_OUTPUT: agentResult.output?.join('\n') ?? null,
            });
            this.deps.runtimeStore.appendLog(
              ticket.logPath,
              JSON.stringify({
                event: 'merge-back',
                status: 'failed',
                branch: ticket.branchName,
                reason: `Readiness checks failed after conflict resolution: ${failed.command}`,
                attempt,
                diagnostics: remainingDiagnostics,
              }),
            );
            return {
              success: false,
              reason: `Readiness checks failed after conflict resolution: ${failed.command}`,
              conflictPaths: remainingDiagnostics.conflictPaths,
            };
          }
          continue;
        }

        if (attempt === budget) {
          abortMerge(input.featureWorktreePath);
          this.deps.runtimeStore.updateMetadata(ticket.metadataPath, {
            MERGE_STATUS: 'failed',
            MERGE_CONFLICT_PATHS: remainingDiagnostics.conflictPaths,
            MERGE_FINAL_DIAGNOSTICS: remainingDiagnostics,
            MERGE_RESOLUTION_OUTPUT: agentResult.output?.join('\n') ?? null,
          });
          this.deps.runtimeStore.appendLog(
            ticket.logPath,
            JSON.stringify({
              event: 'merge-back',
              status: 'failed',
              branch: ticket.branchName,
              reason: `Conflicts remain after ${budget} resolution attempts`,
              attempt,
              diagnostics: remainingDiagnostics,
            }),
          );
          return {
            success: false,
            reason: `Conflicts remain after ${budget} resolution attempts`,
            conflictPaths: remainingDiagnostics.conflictPaths,
          };
        }
        continue;
      }

      if (attempt === budget) {
        abortMerge(input.featureWorktreePath);
        this.deps.runtimeStore.updateMetadata(ticket.metadataPath, {
          MERGE_STATUS: 'failed',
          MERGE_CONFLICT_PATHS: finalDiagnostics.conflictPaths,
          MERGE_FINAL_DIAGNOSTICS: finalDiagnostics,
          MERGE_RESOLUTION_OUTPUT: agentResult.output?.join('\n') ?? null,
        });
        this.deps.runtimeStore.appendLog(
          ticket.logPath,
          JSON.stringify({
            event: 'merge-back',
            status: 'failed',
            branch: ticket.branchName,
            reason: `Reviewer agent failed to resolve conflicts after ${budget} attempts`,
            attempt,
            diagnostics: finalDiagnostics,
          }),
        );
        return {
          success: false,
          reason: `Reviewer agent failed to resolve conflicts after ${budget} attempts`,
          conflictPaths: finalDiagnostics.conflictPaths,
        };
      }
    }

    abortMerge(input.featureWorktreePath);
    return { success: false, reason: 'Unexpected merge failure', conflictPaths: finalDiagnostics.conflictPaths };
  }

  private async invokeReviewerAgent(
    input: MergeWaveInput,
    ticket: MergeBackTicket,
    prompt: string,
  ): Promise<AgentExecutionResult> {
    return this.invokeConflictResolutionAgent(input, ticket, prompt, 'reviewer');
  }

  private async invokeConflictResolutionAgent(
    input: Pick<
      MergeWaveInput,
      | 'repoRoot'
      | 'feature'
      | 'featureWorktreePath'
      | 'featureBranchName'
      | 'model'
      | 'reviewerModel'
      | 'reviewerPrompt'
      | 'onProgress'
    > & { invocationMode?: AgentInvocationMode },
    ticket: MergeBackTicket,
    prompt: string,
    invocationMode: AgentInvocationMode = input.invocationMode ?? 'reviewer',
  ): Promise<AgentExecutionResult> {
    const plan = buildAgentPlan(input, ticket);
    return this.deps.agentExecutionProvider.execute({
      plan,
      ticketIndex: 0,
      prompt,
      invocationMode,
      onProgress: input.onProgress,
    });
  }

  private async invokeReviewerAgentForBaseMerge(
    input: {
      repoRoot: string;
      feature: string;
      model: LaunchModel;
      reviewerModel?: LaunchModel;
      reviewerPrompt?: { id: string; label: string; path: string; content?: string };
      onProgress?: AgentExecutionProgressCallback;
    },
    prompt: string,
  ): Promise<AgentExecutionResult> {
    const ticketRecord: TicketRecord = {
      path: '',
      feature: input.feature,
      issueName: 'base-merge',
      label: `${input.feature}/base-merge`,
      executorAfk: true,
    };

    const checkout: CheckoutContext = {
      featureSlug: input.feature,
      defaultWorktreeName: input.feature,
      effectiveWorktreeName: input.feature,
      defaultBranchName: input.feature,
      effectiveBranchName: input.feature,
      worktreePath: input.repoRoot,
    };

    const plan: LaunchPlan = {
      repoRoot: input.repoRoot,
      model: input.model,
      reviewerModel: input.reviewerModel,
      reviewerPrompt: input.reviewerPrompt ?? resolveReviewerPrompt({ repoRoot: input.repoRoot }),
      tickets: [ticketRecord],
      gitContext: { commits: [] },
      checkout,
    };

    return this.deps.agentExecutionProvider.execute({
      plan,
      ticketIndex: 0,
      prompt,
      invocationMode: 'reviewer',
      onProgress: input.onProgress,
    });
  }
}

function sortTicketsByDependencies(tickets: MergeBackTicket[]): MergeBackTicket[] {
  const byIssueName = new Map(tickets.map((t) => [t.issueName, t]));
  const visited = new Set<string>();
  const result: MergeBackTicket[] = [];

  function visit(ticket: MergeBackTicket): void {
    if (visited.has(ticket.issueName)) return;
    visited.add(ticket.issueName);
    for (const dep of ticket.dependsOn ?? []) {
      const depTicket = byIssueName.get(dep);
      if (depTicket) visit(depTicket);
    }
    result.push(ticket);
  }

  for (const ticket of tickets) {
    visit(ticket);
  }

  return result;
}

function tryMerge(worktreePath: string, branchName: string): { success: boolean; output: string } {
  try {
    const output = runGit(worktreePath, ['merge', '--no-edit', branchName]);
    return { success: true, output };
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error);
    return { success: false, output };
  }
}

function discardWorktreeChanges(worktreePath: string): void {
  runGit(worktreePath, ['reset', '--hard', 'HEAD']);
  runGit(worktreePath, ['clean', '-fd']);
}

function cleanupMergedIssueResources(input: MergeBackCleanupInput): MergeBackCleanupResult {
  const { repoRoot, featureWorktreePath, featureBranchName, ticket, mergedIssueTip } = input;
  const reachability = checkBranchReachability(
    featureWorktreePath,
    featureBranchName,
    mergedIssueTip,
    ticket.issueName,
  );
  if (!reachability.ok) {
    return {
      feature: ticket.feature,
      issueName: ticket.issueName,
      branchName: ticket.branchName,
      worktreePath: ticket.worktreePath,
      featureWorktreePath,
      featureBranchName,
      mergedIssueTip,
      success: false,
      deletedBranch: false,
      deletedWorktree: false,
      warning: reachability.reason,
    };
  }

  const cleanWorktree = checkWorktreeClean(repoRoot, ticket.worktreePath);
  if (!cleanWorktree.ok) {
    return {
      feature: ticket.feature,
      issueName: ticket.issueName,
      branchName: ticket.branchName,
      worktreePath: ticket.worktreePath,
      featureWorktreePath,
      featureBranchName,
      mergedIssueTip,
      success: false,
      deletedBranch: false,
      deletedWorktree: false,
      warning: cleanWorktree.reason,
    };
  }

  let deletedWorktree = false;
  let deletedBranch = false;
  const errors: string[] = [];

  try {
    runGit(repoRoot, ['worktree', 'remove', '-f', ticket.worktreePath]);
    deletedWorktree = true;
  } catch (error) {
    errors.push(`worktree delete failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    runGit(repoRoot, ['branch', '-D', ticket.branchName]);
    deletedBranch = true;
  } catch (error) {
    errors.push(`branch delete failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    feature: ticket.feature,
    issueName: ticket.issueName,
    branchName: ticket.branchName,
    worktreePath: ticket.worktreePath,
    featureWorktreePath,
    featureBranchName,
    mergedIssueTip,
    success: deletedWorktree && deletedBranch,
    deletedBranch,
    deletedWorktree,
    error: errors.length > 0 ? errors.join(' | ') : undefined,
  };
}

function checkBranchReachability(
  worktreePath: string,
  featureBranchName: string,
  issueTip: string,
  issueName: string,
): { ok: true } | { ok: false; reason: string } {
  try {
    runGit(worktreePath, ['merge-base', '--is-ancestor', issueTip, featureBranchName]);
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: `merge proof failed for ${issueName}: branch tip is not reachable from feature HEAD`,
    };
  }
}

function resolveBranchTip(worktreePath: string, branchName: string): string {
  return runGit(worktreePath, ['rev-parse', `${branchName}^{commit}`]).trim();
}

function checkWorktreeClean(repoRoot: string, worktreePath: string): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(worktreePath)) {
    return { ok: false, reason: `issue worktree has uncommitted changes or is unavailable: ${worktreePath}` };
  }

  try {
    const status = runGit(worktreePath, ['status', '--porcelain']);
    if (status.trim().length === 0) return { ok: true };
    return { ok: false, reason: `issue worktree has uncommitted changes: ${worktreePath}` };
  } catch {
    const listing = runGit(repoRoot, ['worktree', 'list', '--porcelain']);
    const registered = listing.split('\n').some((line) => line.trim() === `worktree ${path.resolve(worktreePath)}`);
    if (!registered) {
      return { ok: false, reason: `issue worktree has uncommitted changes or is unavailable: ${worktreePath}` };
    }
    return { ok: false, reason: `issue worktree has uncommitted changes: ${worktreePath}` };
  }
}

function getConflictPaths(worktreePath: string): string[] {
  try {
    const output = runGit(worktreePath, ['diff', '--name-only', '--diff-filter=U']);
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function getStatusShort(worktreePath: string): string {
  try {
    return runGit(worktreePath, ['status', '--short']);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function getMergeConflictDiagnostics(worktreePath: string): MergeConflictDiagnostics {
  const conflictPaths = getConflictPaths(worktreePath);
  const markersRemain = hasConflictMarkers(worktreePath);
  const unmergedIndexPaths = conflictPaths;
  const statusShort = getStatusShort(worktreePath);
  const summary = [
    `Unmerged index entries: ${unmergedIndexPaths.length > 0 ? unmergedIndexPaths.join(', ') : 'none'}`,
    `Conflict markers remain: ${markersRemain ? 'yes' : 'no'}`,
    unmergedIndexPaths.length > 0 && !markersRemain
      ? 'Files with no conflict markers but unmerged index entries remain unresolved Git index state and must still be staged/resolved.'
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  return { conflictPaths, statusShort, markersRemain, unmergedIndexPaths, summary };
}

function hasConflictMarkers(worktreePath: string): boolean {
  try {
    const output = runGit(worktreePath, ['grep', '-l', '^<<<<<<< ']);
    return output.length > 0;
  } catch (error) {
    const code = (error as { status?: number }).status;
    if (code === 1) return false;
    return false;
  }
}

export function isMergeInProgress(worktreePath: string): boolean {
  const gitDir = resolveGitDir(worktreePath);
  return existsSync(path.join(gitDir, 'MERGE_HEAD'));
}

function abortMerge(worktreePath: string): void {
  try {
    runGit(worktreePath, ['merge', '--abort']);
  } catch {
    try {
      runGit(worktreePath, ['reset', '--hard', 'HEAD']);
    } catch {
      // Best effort cleanup
    }
  }
}

function commitMerge(worktreePath: string, message: string): void {
  runGit(worktreePath, ['-c', 'user.name=AFK MergeBack', '-c', 'user.email=afk@localhost', 'commit', '-m', message]);
}

function resolveGitDir(worktreePath: string): string {
  const gitFile = path.join(worktreePath, '.git');
  try {
    const content = readFileSync(gitFile, 'utf8').trim();
    if (content.startsWith('gitdir:')) {
      return content.slice(7).trim();
    }
  } catch {
    // .git is a directory
  }
  return gitFile;
}

function buildConflictResolutionPrompt(
  ticket: MergeBackTicket,
  diagnostics: MergeConflictDiagnostics,
  attempt: number,
  budget: number,
): string {
  const promptTemplate = resolveReviewerPrompt({ repoRoot: '', override: CONFLICT_RESOLUTION_PROMPT_ID });
  const { conflictPaths } = diagnostics;
  const conflictSection =
    conflictPaths.length > 0 ? `\n## Conflicting Files\n\n${conflictPaths.map((p) => `- ${p}`).join('\n')}\n` : '';
  const statusSection = diagnostics.statusShort.trim().length > 0 ? diagnostics.statusShort : '(clean)';
  const unmergedSection =
    diagnostics.unmergedIndexPaths.length > 0
      ? diagnostics.unmergedIndexPaths.map((p) => `- ${p}`).join('\n')
      : '- none';
  return `# Conflict Resolution Request

Ticket: ${ticket.feature}/${ticket.issueName}
Branch: ${ticket.branchName}
Attempt: ${attempt} of ${budget}

A merge conflict occurred when merging scratch branch \`${ticket.branchName}\` into the feature worktree.
${conflictSection}

## Current Git Diagnostics

Status (git status --short):

\`\`\`
${statusSection}
\`\`\`

Unmerged index entries (git diff --name-only --diff-filter=U):

${unmergedSection}

Conflict markers remain: ${diagnostics.markersRemain ? 'yes' : 'no'}

${diagnostics.summary}

## Instructions

1. Inspect each conflicting file in the feature worktree.
2. Understand the intent of both sides of each conflict.
3. Synthesize the correct merged result that preserves both changes where possible.
4. Remove ALL conflict markers (<<<<<<<, =======, >>>>>>>).
5. Ensure the merged code is syntactically valid and semantically coherent.
6. Run any available smoke tests or static checks to verify correctness.
7. You MAY run local Git state commands needed for resolution, including \`git status\`, conflict-stage inspection, \`git add\` for resolved paths, and \`git merge --continue\` or \`git commit\` to complete the merge when appropriate. Do NOT push, force-reset unrelated work, change unrelated branches, or edit unrelated files.

${promptTemplate.content ?? ''}
`;
}

function buildAgentPlan(
  input: Pick<
    MergeWaveInput,
    'repoRoot' | 'feature' | 'featureWorktreePath' | 'featureBranchName' | 'model' | 'reviewerModel' | 'reviewerPrompt'
  >,
  ticket: MergeBackTicket,
): LaunchPlan {
  const ticketRecord: TicketRecord = {
    path: ticket.metadataPath,
    feature: ticket.feature,
    issueName: ticket.issueName,
    label: `${ticket.feature}/${ticket.issueName}`,
    executorAfk: true,
  };

  const checkout: CheckoutContext = {
    featureSlug: input.feature,
    defaultWorktreeName: input.feature,
    effectiveWorktreeName: input.feature,
    defaultBranchName: input.featureBranchName,
    effectiveBranchName: input.featureBranchName,
    worktreePath: input.featureWorktreePath,
  };

  return {
    repoRoot: input.repoRoot,
    model: input.model,
    reviewerModel: input.reviewerModel,
    reviewerPrompt: input.reviewerPrompt ?? resolveReviewerPrompt({ repoRoot: input.repoRoot }),
    tickets: [ticketRecord],
    gitContext: { commits: [] },
    checkout,
  };
}
