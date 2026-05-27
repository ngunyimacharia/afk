import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { RuntimeMetadataRecord } from './types.js';
import { runGit } from './worktree-preparation-service.js';

const TERMINAL_STATUSES = new Set(['done', 'closed', 'complete', 'resolved']);

export interface CleanupPlannerInput {
  repoRoot: string;
}

export interface CleanupTarget {
  feature: string;
  issueName: string;
  issuePath: string;
  logPath?: string;
  metadataPath?: string;
  doneSentinelPath?: string;
  failedSentinelPath?: string;
  handoffSentinelPath?: string;
  reason: string;
}

export interface CleanupPlan {
  terminalTargets: CleanupTarget[];
  pendingPostMergeCleanupTargets: PendingPostMergeCleanupItem[];
  preservedIssues: string[];
  preservedArtifacts: string[];
  featureDirectoriesToDelete: string[];
  workspaceExecutionPath?: string;
}

export interface PendingPostMergeCleanupItem {
  feature: string;
  issueName: string;
  branchName: string;
  worktreePath: string;
  featureWorktreePath: string;
  featureBranchName: string;
  mergedIssueTip: string;
  warning?: string;
  error?: string;
  failedAt: string;
}

export interface PendingPostMergeCleanupResult extends PendingPostMergeCleanupItem {
  success: boolean;
  deletedBranch: boolean;
  deletedWorktree: boolean;
}

function _readTerminalStatuses(): Set<string> {
  return TERMINAL_STATUSES;
}

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function exists(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function parseFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return {};
  return (YAML.parse(content.slice(4, end)) ?? {}) as Record<string, unknown>;
}

function parseStatus(content: string, frontmatter: Record<string, unknown>): string | undefined {
  const frontmatterStatus = frontmatter.status;
  if (typeof frontmatterStatus === 'string' && frontmatterStatus.trim()) return frontmatterStatus.trim();
  void content;
  return undefined;
}

function ticketLogPath(repoRoot: string, feature: string, issueName: string): string {
  return path.join(repoRoot, '.scratch', '.opencode-afk-logs', `${feature}-${issueName}.log`);
}

function ticketMetadataPath(repoRoot: string, feature: string, issueName: string): string {
  return path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', `${feature}-${issueName}.json`);
}

function pendingPostMergeCleanupPath(repoRoot: string): string {
  return path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'pending-post-merge-cleanup.json');
}

function parsePendingPostMergeCleanup(value: unknown): PendingPostMergeCleanupItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => item as Record<string, unknown>)
    .filter(
      (item) =>
        typeof item.feature === 'string' &&
        typeof item.issueName === 'string' &&
        typeof item.branchName === 'string' &&
        typeof item.worktreePath === 'string' &&
        typeof item.featureWorktreePath === 'string' &&
        typeof item.featureBranchName === 'string' &&
        typeof item.mergedIssueTip === 'string' &&
        typeof item.failedAt === 'string',
    )
    .map((item) => ({
      feature: item.feature as string,
      issueName: item.issueName as string,
      branchName: item.branchName as string,
      worktreePath: item.worktreePath as string,
      featureWorktreePath: item.featureWorktreePath as string,
      featureBranchName: item.featureBranchName as string,
      mergedIssueTip: item.mergedIssueTip as string,
      failedAt: item.failedAt as string,
      warning: typeof item.warning === 'string' ? item.warning : undefined,
      error: typeof item.error === 'string' ? item.error : undefined,
    }));
}

export function readPendingPostMergeCleanupItems(repoRoot: string): PendingPostMergeCleanupItem[] {
  const pendingPath = pendingPostMergeCleanupPath(repoRoot);
  if (!fileExists(pendingPath)) return [];
  try {
    const payload = JSON.parse(readFileSync(pendingPath, 'utf8')) as unknown;
    return parsePendingPostMergeCleanup(payload);
  } catch {
    return [];
  }
}

function writePendingPostMergeCleanupItems(repoRoot: string, items: PendingPostMergeCleanupItem[]): void {
  const pendingPath = pendingPostMergeCleanupPath(repoRoot);
  mkdirSync(path.dirname(pendingPath), { recursive: true });
  writeFileSync(pendingPath, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
}

export function persistFailedPostMergeCleanupItem(repoRoot: string, item: PendingPostMergeCleanupItem): void {
  const pending = readPendingPostMergeCleanupItems(repoRoot);
  const next = [...pending.filter((entry) => entry.feature !== item.feature || entry.issueName !== item.issueName), item];
  writePendingPostMergeCleanupItems(repoRoot, next);
}

function checkBranchReachability(
  worktreePath: string,
  featureBranchName: string,
  issueTip: string,
): { ok: true } | { ok: false; reason: string } {
  try {
    runGit(worktreePath, ['merge-base', '--is-ancestor', issueTip, featureBranchName]);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'merge proof failed: branch tip is not reachable from feature HEAD' };
  }
}

function checkWorktreeClean(repoRoot: string, worktreePath: string): { ok: true } | { ok: false; reason: string } {
  if (!exists(worktreePath)) return { ok: false, reason: `issue worktree is unavailable: ${worktreePath}` };
  try {
    const status = runGit(worktreePath, ['status', '--porcelain']);
    if (status.trim().length === 0) return { ok: true };
    return { ok: false, reason: `issue worktree has uncommitted changes: ${worktreePath}` };
  } catch {
    try {
      const listing = runGit(repoRoot, ['worktree', 'list', '--porcelain']);
      const registered = listing.split('\n').some((line) => line.trim() === `worktree ${path.resolve(worktreePath)}`);
      return registered
        ? { ok: false, reason: `issue worktree has uncommitted changes: ${worktreePath}` }
        : { ok: false, reason: `issue worktree is unavailable: ${worktreePath}` };
    } catch {
      return { ok: false, reason: `issue worktree is unavailable: ${worktreePath}` };
    }
  }
}

function retryPostMergeCleanup(repoRoot: string, item: PendingPostMergeCleanupItem): PendingPostMergeCleanupResult {
  const reachability = checkBranchReachability(item.featureWorktreePath, item.featureBranchName, item.mergedIssueTip);
  if (!reachability.ok) {
    return { ...item, success: false, deletedBranch: false, deletedWorktree: false, warning: reachability.reason };
  }
  const cleanWorktree = checkWorktreeClean(repoRoot, item.worktreePath);
  if (!cleanWorktree.ok) {
    return { ...item, success: false, deletedBranch: false, deletedWorktree: false, warning: cleanWorktree.reason };
  }

  let deletedWorktree = false;
  let deletedBranch = false;
  const errors: string[] = [];
  try {
    runGit(repoRoot, ['worktree', 'remove', '-f', item.worktreePath]);
    deletedWorktree = true;
  } catch (error) {
    errors.push(`worktree delete failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    runGit(repoRoot, ['branch', '-D', item.branchName]);
    deletedBranch = true;
  } catch (error) {
    errors.push(`branch delete failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    ...item,
    success: deletedWorktree && deletedBranch,
    deletedBranch,
    deletedWorktree,
    error: errors.length > 0 ? errors.join(' | ') : undefined,
    warning: undefined,
  };
}

function ticketSentinelPath(
  repoRoot: string,
  feature: string,
  issueName: string,
  kind: 'done' | 'failed' | 'handoff',
): string {
  return path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'sentinels', `${feature}-${issueName}.${kind}`);
}

function readRuntimeMetadataRecord(repoRoot: string, feature: string, issueName: string): RuntimeMetadataRecord | null {
  const metadataPath = ticketMetadataPath(repoRoot, feature, issueName);
  if (!fileExists(metadataPath)) return null;
  try {
    return JSON.parse(readFileSync(metadataPath, 'utf8')) as RuntimeMetadataRecord;
  } catch {
    return null;
  }
}

function isTerminalTicketStatus(status: string | undefined, runtime: RuntimeMetadataRecord | null): boolean {
  const normalized = normalize(status);
  const isFrontmatterTerminal = TERMINAL_STATUSES.has(normalized);
  // Preserve handoff/manual-review work even if frontmatter looks terminal
  if (runtime?.RUN_STATUS === 'handoff') return false;
  if (runtime?.IMPLEMENTATION_STATUS === 'completed' && runtime?.REVIEW_STATUS === 'unavailable') return false;
  return isFrontmatterTerminal;
}

export class CleanupPlanner {
  constructor(private readonly input: CleanupPlannerInput) {}

  buildPlan(): CleanupPlan {
    const scratchRoot = path.join(this.input.repoRoot, '.scratch');
    if (!exists(scratchRoot)) {
      return {
        terminalTargets: [],
        pendingPostMergeCleanupTargets: readPendingPostMergeCleanupItems(this.input.repoRoot),
        preservedIssues: [],
        preservedArtifacts: [],
        featureDirectoriesToDelete: [],
      };
    }
    const features = readdirSync(scratchRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const terminalTargets: CleanupTarget[] = [];
    const preservedIssues: string[] = [];
    const preservedArtifacts: string[] = [];
    const featureDirectoriesToDelete: string[] = [];

    for (const featureDir of features) {
      const issuesDir = path.join(scratchRoot, featureDir.name, 'issues');
      if (!exists(issuesDir)) continue;
      const issueFiles = readdirSync(issuesDir).filter((file) => file.endsWith('.md'));
      let hasPending = false;
      for (const file of issueFiles) {
        const issuePath = path.join(issuesDir, file);
        const content = readFileSync(issuePath, 'utf8');
        const frontmatter = parseFrontmatter(content);
        const status = parseStatus(content, frontmatter);
        const issueName = path.basename(file, '.md');
        const runtime = readRuntimeMetadataRecord(this.input.repoRoot, featureDir.name, issueName);
        const isTerminal = isTerminalTicketStatus(status, runtime);
        if (isTerminal) {
          terminalTargets.push({
            feature: featureDir.name,
            issueName,
            issuePath,
            logPath: fileExists(ticketLogPath(this.input.repoRoot, featureDir.name, issueName))
              ? ticketLogPath(this.input.repoRoot, featureDir.name, issueName)
              : undefined,
            metadataPath: fileExists(ticketMetadataPath(this.input.repoRoot, featureDir.name, issueName))
              ? ticketMetadataPath(this.input.repoRoot, featureDir.name, issueName)
              : undefined,
            doneSentinelPath: fileExists(ticketSentinelPath(this.input.repoRoot, featureDir.name, issueName, 'done'))
              ? ticketSentinelPath(this.input.repoRoot, featureDir.name, issueName, 'done')
              : undefined,
            failedSentinelPath: fileExists(
              ticketSentinelPath(this.input.repoRoot, featureDir.name, issueName, 'failed'),
            )
              ? ticketSentinelPath(this.input.repoRoot, featureDir.name, issueName, 'failed')
              : undefined,
            handoffSentinelPath: fileExists(
              ticketSentinelPath(this.input.repoRoot, featureDir.name, issueName, 'handoff'),
            )
              ? ticketSentinelPath(this.input.repoRoot, featureDir.name, issueName, 'handoff')
              : undefined,
            reason: `terminal status: ${status}`,
          });
        } else {
          hasPending = true;
          preservedIssues.push(issuePath);
        }
      }
      if (!hasPending && issueFiles.length > 0)
        featureDirectoriesToDelete.push(path.join(scratchRoot, featureDir.name));
    }

    for (const target of terminalTargets) {
      if (target.logPath) preservedArtifacts.push(target.logPath);
      if (target.metadataPath) preservedArtifacts.push(target.metadataPath);
      if (target.doneSentinelPath) preservedArtifacts.push(target.doneSentinelPath);
      if (target.failedSentinelPath) preservedArtifacts.push(target.failedSentinelPath);
      if (target.handoffSentinelPath) preservedArtifacts.push(target.handoffSentinelPath);
    }

    const workspaceExecutionPath = fileExists(path.join(scratchRoot, 'execution.json'))
      ? path.join(scratchRoot, 'execution.json')
      : undefined;
    return {
      terminalTargets,
      pendingPostMergeCleanupTargets: readPendingPostMergeCleanupItems(this.input.repoRoot),
      preservedIssues,
      preservedArtifacts,
      featureDirectoriesToDelete,
      workspaceExecutionPath,
    };
  }
}

export class CleanupExecutor {
  execute(plan: CleanupPlan, repoRoot: string): { deleted: string[]; postMergeCleanupResults: PendingPostMergeCleanupResult[] } {
    const deleted: string[] = [];
    const postMergeCleanupResults: PendingPostMergeCleanupResult[] = [];
    const remainingPending: PendingPostMergeCleanupItem[] = [];

    for (const pending of plan.pendingPostMergeCleanupTargets) {
      const retry = retryPostMergeCleanup(repoRoot, pending);
      postMergeCleanupResults.push(retry);
      if (!retry.success) {
        remainingPending.push({
          ...pending,
          warning: retry.warning,
          error: retry.error,
          failedAt: new Date().toISOString(),
        });
      }
    }

    writePendingPostMergeCleanupItems(repoRoot, remainingPending);

    for (const target of plan.terminalTargets) {
      for (const filePath of [
        target.issuePath,
        target.logPath,
        target.metadataPath,
        target.doneSentinelPath,
        target.failedSentinelPath,
        target.handoffSentinelPath,
      ].filter((value): value is string => Boolean(value))) {
        try {
          rmSync(filePath, { force: true, recursive: false });
          deleted.push(filePath);
        } catch {}
      }
    }
    for (const featureDir of plan.featureDirectoriesToDelete) {
      try {
        rmSync(featureDir, { force: true, recursive: true });
        deleted.push(featureDir);
      } catch {}
    }
    if (plan.workspaceExecutionPath) {
      try {
        rmSync(plan.workspaceExecutionPath, { force: true, recursive: false });
        deleted.push(plan.workspaceExecutionPath);
      } catch {}
    }
    return { deleted, postMergeCleanupResults };
  }
}
