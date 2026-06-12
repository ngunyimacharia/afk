import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { RuntimeMetadataRecord } from './types.js';
import { runGit } from './worktree-preparation-service.js';

const TERMINAL_STATUSES = new Set(['done', 'closed', 'complete', 'resolved']);

export interface CleanupPlannerInput {
  repoRoot: string;
  issueSource?: CleanupIssueSource;
}

export interface CleanupIssueSource {
  listCleanupIssues(): CleanupIssueRecord[];
}

export interface CleanupIssueRecord {
  feature: string;
  issueName: string;
  issuePath?: string;
  status?: string;
}

export interface CleanupIssueDeletionTarget {
  feature: string;
  issueName: string;
  issuePath: string;
  reason: string;
}

export interface RuntimeArtifactCleanupTarget {
  feature: string;
  issueName: string;
  logPath?: string;
  metadataPath?: string;
  doneSentinelPath?: string;
  failedSentinelPath?: string;
  handoffSentinelPath?: string;
}

export interface CleanupTarget {
  feature: string;
  issueName: string;
  issuePath?: string;
  logPath?: string;
  metadataPath?: string;
  linearMirrorPath?: string;
  doneSentinelPath?: string;
  failedSentinelPath?: string;
  handoffSentinelPath?: string;
  reason: string;
}

export interface CleanupPlan {
  terminalTargets: CleanupTarget[];
  issueDeletionTargets: CleanupIssueDeletionTarget[];
  runtimeArtifactTargets: RuntimeArtifactCleanupTarget[];
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

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

function resolvePathWithinRoot(rootPath: string, relativePath: string): string | undefined {
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, relativePath);
  return isPathWithinRoot(resolved, root) ? resolved : undefined;
}

function existingFilePath(candidatePath: string | undefined): string | undefined {
  return candidatePath && fileExists(candidatePath) ? candidatePath : undefined;
}

function ticketLogRoot(repoRoot: string): string {
  return path.resolve(repoRoot, '.scratch', '.opencode-afk-logs');
}

function ticketLogPath(repoRoot: string, feature: string, issueName: string): string | undefined {
  return resolvePathWithinRoot(ticketLogRoot(repoRoot), `${feature}-${issueName}.log`);
}

function ticketMetadataRoot(repoRoot: string): string {
  return path.resolve(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata');
}

function ticketMetadataPath(repoRoot: string, feature: string, issueName: string): string | undefined {
  return resolvePathWithinRoot(ticketMetadataRoot(repoRoot), `${feature}-${issueName}.json`);
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
  const next = [
    ...pending.filter((entry) => entry.feature !== item.feature || entry.issueName !== item.issueName),
    item,
  ];
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
): string | undefined {
  const sentinelRoot = path.resolve(repoRoot, '.scratch', '.opencode-afk-logs', 'sentinels');
  return resolvePathWithinRoot(sentinelRoot, `${feature}-${issueName}.${kind}`);
}

function readRuntimeMetadataRecord(repoRoot: string, feature: string, issueName: string): RuntimeMetadataRecord | null {
  const metadataPath = existingFilePath(ticketMetadataPath(repoRoot, feature, issueName));
  if (!metadataPath) return null;
  try {
    return JSON.parse(readFileSync(metadataPath, 'utf8')) as RuntimeMetadataRecord;
  } catch {
    return null;
  }
}

function runtimeArtifactTarget(repoRoot: string, feature: string, issueName: string): RuntimeArtifactCleanupTarget {
  return {
    feature,
    issueName,
    logPath: existingFilePath(ticketLogPath(repoRoot, feature, issueName)),
    metadataPath: existingFilePath(ticketMetadataPath(repoRoot, feature, issueName)),
    doneSentinelPath: existingFilePath(ticketSentinelPath(repoRoot, feature, issueName, 'done')),
    failedSentinelPath: existingFilePath(ticketSentinelPath(repoRoot, feature, issueName, 'failed')),
    handoffSentinelPath: existingFilePath(ticketSentinelPath(repoRoot, feature, issueName, 'handoff')),
  };
}

export class ScratchCleanupIssueSource implements CleanupIssueSource {
  constructor(private readonly repoRoot: string) {}

  listCleanupIssues(): CleanupIssueRecord[] {
    const scratchRoot = path.join(this.repoRoot, '.scratch');
    if (!exists(scratchRoot)) return [];
    const features = readdirSync(scratchRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    return features.flatMap((featureDir) => {
      const issuesDir = path.join(scratchRoot, featureDir.name, 'issues');
      if (!exists(issuesDir)) return [];
      return readdirSync(issuesDir)
        .filter((file) => file.endsWith('.md'))
        .map((file) => {
          const issuePath = path.join(issuesDir, file);
          const content = readFileSync(issuePath, 'utf8');
          const frontmatter = parseFrontmatter(content);
          return {
            feature: featureDir.name,
            issueName: path.basename(file, '.md'),
            issuePath,
            status: parseStatus(content, frontmatter),
          };
        });
    });
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

function isTerminalRuntimeStatus(runtime: RuntimeMetadataRecord): boolean {
  return ['completed', 'failed', 'blocked', 'interrupted'].includes(normalize(runtime.RUN_STATUS ?? runtime.STATUS));
}

function linearMirrorRoot(repoRoot: string): string {
  return path.resolve(repoRoot, '.scratch', '.opencode-afk-logs', 'linear-mirrors');
}

function linearMirrorPath(repoRoot: string, runtime: RuntimeMetadataRecord | null): string | undefined {
  const mirrorRoot = linearMirrorRoot(repoRoot);
  for (const candidate of [runtime?.LINEAR_MIRROR_PATH, runtime?.TICKET_PATH]) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (isPathWithinRoot(resolved, mirrorRoot) && fileExists(resolved)) return resolved;
  }
  return undefined;
}

export class CleanupPlanner {
  constructor(private readonly input: CleanupPlannerInput) {}

  buildPlan(): CleanupPlan {
    const scratchRoot = path.join(this.input.repoRoot, '.scratch');
    if (!exists(scratchRoot)) {
      return {
        terminalTargets: [],
        issueDeletionTargets: [],
        runtimeArtifactTargets: [],
        pendingPostMergeCleanupTargets: readPendingPostMergeCleanupItems(this.input.repoRoot),
        preservedIssues: [],
        preservedArtifacts: [],
        featureDirectoriesToDelete: [],
      };
    }
    const source = this.input.issueSource ?? new ScratchCleanupIssueSource(this.input.repoRoot);
    const issues = source.listCleanupIssues();
    const terminalTargets: CleanupTarget[] = [];
    const issueDeletionTargets: CleanupIssueDeletionTarget[] = [];
    const runtimeArtifactTargets: RuntimeArtifactCleanupTarget[] = [];
    const preservedIssues: string[] = [];
    const preservedArtifacts: string[] = [];
    const featureDirectoriesToDelete: string[] = [];

    const byFeature = new Map<string, CleanupIssueRecord[]>();
    for (const issue of issues) {
      const featureIssues = byFeature.get(issue.feature) ?? [];
      featureIssues.push(issue);
      byFeature.set(issue.feature, featureIssues);
    }

    for (const [feature, featureIssues] of byFeature) {
      let hasPending = false;
      for (const issue of featureIssues) {
        const runtime = readRuntimeMetadataRecord(this.input.repoRoot, issue.feature, issue.issueName);
        const isTerminal = isTerminalTicketStatus(issue.status, runtime);
        if (isTerminal) {
          const artifacts = runtimeArtifactTarget(this.input.repoRoot, issue.feature, issue.issueName);
          if (issue.issuePath) {
            issueDeletionTargets.push({
              feature: issue.feature,
              issueName: issue.issueName,
              issuePath: issue.issuePath,
              reason: `terminal status: ${issue.status}`,
            });
          }
          runtimeArtifactTargets.push(artifacts);
          terminalTargets.push({
            ...artifacts,
            feature: issue.feature,
            issueName: issue.issueName,
            issuePath: issue.issuePath,
            linearMirrorPath: linearMirrorPath(this.input.repoRoot, runtime),
            reason: `terminal status: ${issue.status}`,
          });
        } else {
          hasPending = true;
          if (issue.issuePath) preservedIssues.push(issue.issuePath);
        }
      }
      if (!hasPending && featureIssues.length > 0 && featureIssues.every((issue) => issue.issuePath)) {
        featureDirectoriesToDelete.push(path.join(scratchRoot, feature));
      }
    }

    const plannedKeys = new Set(terminalTargets.map((target) => `${target.feature}/${target.issueName}`));
    const metadataRoot = path.join(scratchRoot, '.opencode-afk-logs', 'runtime-metadata');
    if (exists(metadataRoot)) {
      for (const file of readdirSync(metadataRoot).filter((entry) => entry.endsWith('.json'))) {
        const metadataPath = path.join(metadataRoot, file);
        let runtime: RuntimeMetadataRecord;
        try {
          runtime = JSON.parse(readFileSync(metadataPath, 'utf8')) as RuntimeMetadataRecord;
        } catch {
          continue;
        }
        const key = `${runtime.FEATURE_SLUG}/${runtime.ISSUE_NAME}`;
        if (!runtime.LINEAR_ISSUE_KEY || plannedKeys.has(key) || !isTerminalRuntimeStatus(runtime)) continue;
        const mirrorPath = linearMirrorPath(this.input.repoRoot, runtime);
        terminalTargets.push({
          feature: runtime.FEATURE_SLUG,
          issueName: runtime.ISSUE_NAME,
          issuePath: mirrorPath,
          logPath: existingFilePath(ticketLogPath(this.input.repoRoot, runtime.FEATURE_SLUG, runtime.ISSUE_NAME)),
          metadataPath,
          linearMirrorPath: mirrorPath,
          doneSentinelPath: existingFilePath(
            ticketSentinelPath(this.input.repoRoot, runtime.FEATURE_SLUG, runtime.ISSUE_NAME, 'done'),
          ),
          failedSentinelPath: existingFilePath(
            ticketSentinelPath(this.input.repoRoot, runtime.FEATURE_SLUG, runtime.ISSUE_NAME, 'failed'),
          ),
          handoffSentinelPath: existingFilePath(
            ticketSentinelPath(this.input.repoRoot, runtime.FEATURE_SLUG, runtime.ISSUE_NAME, 'handoff'),
          ),
          reason: `terminal Linear run: ${runtime.RUN_STATUS ?? runtime.STATUS}`,
        });
      }
    }

    for (const target of terminalTargets) {
      if (target.logPath) preservedArtifacts.push(target.logPath);
      if (target.metadataPath) preservedArtifacts.push(target.metadataPath);
      if (target.linearMirrorPath) preservedArtifacts.push(target.linearMirrorPath);
      if (target.doneSentinelPath) preservedArtifacts.push(target.doneSentinelPath);
      if (target.failedSentinelPath) preservedArtifacts.push(target.failedSentinelPath);
      if (target.handoffSentinelPath) preservedArtifacts.push(target.handoffSentinelPath);
    }

    const workspaceExecutionPath = fileExists(path.join(scratchRoot, 'execution.json'))
      ? path.join(scratchRoot, 'execution.json')
      : undefined;
    return {
      terminalTargets,
      issueDeletionTargets,
      runtimeArtifactTargets,
      pendingPostMergeCleanupTargets: readPendingPostMergeCleanupItems(this.input.repoRoot),
      preservedIssues,
      preservedArtifacts,
      featureDirectoriesToDelete,
      workspaceExecutionPath,
    };
  }
}

export class CleanupExecutor {
  execute(
    plan: CleanupPlan,
    repoRoot: string,
  ): { deleted: string[]; postMergeCleanupResults: PendingPostMergeCleanupResult[] } {
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

    const pathsToDelete = [
      ...plan.issueDeletionTargets.map((target) => target.issuePath),
      ...plan.runtimeArtifactTargets.flatMap((target) => [
        target.logPath,
        target.metadataPath,
        target.doneSentinelPath,
        target.failedSentinelPath,
        target.handoffSentinelPath,
      ]),
      ...plan.terminalTargets.map((target) => target.linearMirrorPath),
    ].filter((value): value is string => Boolean(value));

    for (const filePath of new Set(pathsToDelete)) {
      try {
        rmSync(filePath, { force: true, recursive: false });
        deleted.push(filePath);
      } catch {}
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
