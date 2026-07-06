import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type {
  SandcastleCleanupResource,
  SandcastleCleanupResult,
  SandcastleRuntimeRecord,
} from './sandcastle-runtime-store.js';
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

export interface SandcastleCleanupResourceTarget {
  runId: string;
  recordPath: string;
  feature: string;
  issueName: string;
  resource: SandcastleCleanupResource;
}

export interface OrphanedWorktreeCleanupTarget {
  feature: string;
  issueName: string;
  branchName: string;
  worktreePath: string;
  reason: string;
}

export interface OrphanedWorktreeCleanupResult extends OrphanedWorktreeCleanupTarget {
  success: boolean;
  deletedBranch: boolean;
  deletedWorktree: boolean;
  warning?: string;
  error?: string;
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
  sandcastleResourceTargets?: SandcastleCleanupResourceTarget[];
  orphanedWorktreeTargets: OrphanedWorktreeCleanupTarget[];
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

function sandcastleRunsRoot(repoRoot: string): string {
  return path.join(repoRoot, '.scratch', 'sandcastle-runtime', 'runs');
}

function readSandcastleRuntimeRecords(
  repoRoot: string,
): Array<{ record: SandcastleRuntimeRecord; recordPath: string }> {
  const runsRoot = sandcastleRunsRoot(repoRoot);
  if (!exists(runsRoot)) return [];
  return readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsRoot, entry.name, 'record.json'))
    .filter(fileExists)
    .flatMap((recordPath) => {
      try {
        return [{ record: JSON.parse(readFileSync(recordPath, 'utf8')) as SandcastleRuntimeRecord, recordPath }];
      } catch {
        return [];
      }
    });
}

function writeSandcastleRuntimeRecord(recordPath: string, record: SandcastleRuntimeRecord): void {
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
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
  const warnings: string[] = [];
  const reachability = checkBranchReachability(item.featureWorktreePath, item.featureBranchName, item.mergedIssueTip);
  if (!reachability.ok) {
    warnings.push(reachability.reason);
  }

  const cleanWorktrees = checkBranchWorktreesClean(repoRoot, item.branchName);
  if (!cleanWorktrees.ok) {
    return { ...item, success: false, deletedBranch: false, deletedWorktree: false, warning: cleanWorktrees.reason };
  }

  const worktreeCleanup = removeWorktreesForBranch(repoRoot, item.branchName);
  if (!worktreeCleanup.success) {
    return {
      ...item,
      success: false,
      deletedBranch: false,
      deletedWorktree: worktreeCleanup.removedCount > 0,
      error: worktreeCleanup.error,
    };
  }

  let deletedBranch = false;
  try {
    runGit(repoRoot, ['branch', '-D', item.branchName]);
    deletedBranch = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('not found')) {
      return {
        ...item,
        success: false,
        deletedBranch: false,
        deletedWorktree: true,
        error: `branch delete failed: ${message}`,
        warning: warnings[0],
      };
    }
    warnings.push(`branch already deleted: ${item.branchName}`);
  }

  return {
    ...item,
    success: true,
    deletedBranch,
    deletedWorktree: worktreeCleanup.removedCount > 0,
    warning: warnings.length > 0 ? warnings.join(' | ') : undefined,
  };
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

function checkWorktreeLocked(worktreePath: string): { ok: true } | { ok: false; reason: string } {
  const gitDir = resolveGitDir(worktreePath);
  if (existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
    return { ok: false, reason: `worktree is in a merge: ${worktreePath}` };
  }
  if (existsSync(path.join(gitDir, 'index.lock'))) {
    return { ok: false, reason: `worktree index is locked: ${worktreePath}` };
  }
  return { ok: true };
}

interface GitWorktreeEntry {
  worktreePath: string;
  branchName?: string;
}

function parseGitWorktreeList(repoRoot: string): GitWorktreeEntry[] {
  try {
    const output = runGit(repoRoot, ['worktree', 'list', '--porcelain']);
    return output
      .split('\n\n')
      .map((block) => block.trim())
      .filter(Boolean)
      .map((block) => {
        const lines = block.split('\n');
        const worktreeLine = lines.find((line) => line.startsWith('worktree '));
        const branchLine = lines.find((line) => line.startsWith('branch refs/heads/'));
        return {
          worktreePath: worktreeLine ? worktreeLine.slice('worktree '.length) : '',
          branchName: branchLine ? branchLine.slice('branch refs/heads/'.length) : undefined,
        };
      })
      .filter((entry) => entry.worktreePath);
  } catch {
    return [];
  }
}

export function listWorktreesForBranch(repoRoot: string, branchName: string): GitWorktreeEntry[] {
  return parseGitWorktreeList(repoRoot).filter((entry) => entry.branchName === branchName);
}

export function checkBranchWorktreesClean(
  repoRoot: string,
  branchName: string,
): { ok: true } | { ok: false; reason: string } {
  for (const { worktreePath } of listWorktreesForBranch(repoRoot, branchName)) {
    const clean = checkWorktreeClean(repoRoot, worktreePath);
    if (!clean.ok) return clean;
  }
  return { ok: true };
}

export function removeWorktreesForBranch(
  repoRoot: string,
  branchName: string,
): { success: true; removedCount: number } | { success: false; removedCount: number; error: string } {
  const worktrees = listWorktreesForBranch(repoRoot, branchName);
  let removedCount = 0;
  const errors: string[] = [];
  for (const { worktreePath } of worktrees) {
    try {
      runGit(repoRoot, ['worktree', 'remove', '-f', worktreePath]);
      removedCount++;
    } catch (error) {
      errors.push(
        `worktree delete failed for ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (errors.length > 0) {
    return { success: false, removedCount, error: errors.join(' | ') };
  }
  return { success: true, removedCount };
}

function parseAfkIssueBranch(branchName: string): { feature: string; issueName: string } | null {
  const segments = branchName.split('/');
  if (segments.length !== 3 || segments[0] !== 'afk') return null;
  return { feature: segments[1], issueName: segments[2] };
}

function parseNgunyimachariaIssueBranch(branchName: string): { feature: string; issueName: string } | null {
  const segments = branchName.split('/');
  if (segments.length !== 3 || segments[0] !== 'ngunyimacharia') return null;
  return { feature: segments[1], issueName: segments[2] };
}

export function countLeftoverBranches(repoRoot: string, activeTickets: Set<string>): number {
  if (!existsSync(path.join(repoRoot, '.git'))) return 0;
  let output: string;
  try {
    output = runGit(repoRoot, ['branch', '--format', '%(refname:short)']);
  } catch {
    return 0;
  }
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((branchName) => {
      if (!branchName.startsWith('afk/') && !branchName.startsWith('ngunyimacharia/')) return false;
      const parsed = parseAfkIssueBranch(branchName) ?? parseNgunyimachariaIssueBranch(branchName);
      if (!parsed) return true;
      return !activeTickets.has(`${parsed.feature}/${parsed.issueName}`);
    }).length;
}

export function countLeftoverWorktrees(repoRoot: string, activeWorktreePaths: Set<string>): number {
  const worktreeRoot = path.join(repoRoot, '.worktree');
  if (!exists(worktreeRoot)) return 0;
  try {
    return readdirSync(worktreeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => {
        const candidate = path.join(worktreeRoot, entry.name);
        return !activeWorktreePaths.has(safeRealpath(candidate));
      }).length;
  } catch {
    return 0;
  }
}

function safeRealpath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

export { safeRealpath };

function isWithinRepoLocalWorktree(worktreePath: string, repoRoot: string): boolean {
  const resolvedRoot = safeRealpath(repoRoot);
  const resolvedWorktree = safeRealpath(worktreePath);
  const relative = path.relative(resolvedRoot, resolvedWorktree).split(path.sep).join('/');
  return relative.startsWith('.worktree/') && relative !== '.worktree';
}

function buildTerminalRuntimeWorktreeMap(
  records: Array<{ record: SandcastleRuntimeRecord; recordPath: string }>,
): Map<string, { feature: string; issueName: string }> {
  const result = new Map<string, { feature: string; issueName: string }>();
  for (const { record } of records) {
    if (record.terminal.status === 'running' || record.terminal.status === 'handoff') continue;
    const safeWorktreePath = record.worktreePath;
    if (!safeWorktreePath) continue;
    result.set(safeRealpath(safeWorktreePath), {
      feature: record.ticket.featureSlug,
      issueName: record.ticket.issueName,
    });
  }
  return result;
}

function _buildOrphanedWorktreeTargets(
  repoRoot: string,
  terminalKeys: Set<string>,
  records: Array<{ record: SandcastleRuntimeRecord; recordPath: string }>,
): OrphanedWorktreeCleanupTarget[] {
  const pending = readPendingPostMergeCleanupItems(repoRoot);
  const pendingWorktreePaths = new Set(pending.map((item) => safeRealpath(item.worktreePath)));
  const pendingBranchNames = new Set(pending.map((item) => item.branchName));
  const runtimeWorktreeMap = buildTerminalRuntimeWorktreeMap(records);
  const targets: OrphanedWorktreeCleanupTarget[] = [];
  const seenKeys = new Set<string>();

  for (const entry of parseGitWorktreeList(repoRoot)) {
    if (!isWithinRepoLocalWorktree(entry.worktreePath, repoRoot)) continue;
    const resolvedWorktreePath = safeRealpath(entry.worktreePath);
    if (
      pendingWorktreePaths.has(resolvedWorktreePath) ||
      (entry.branchName && pendingBranchNames.has(entry.branchName))
    ) {
      continue;
    }

    let match: { feature: string; issueName: string } | null = null;
    let reason: string | null = null;

    const runtimeMatch = runtimeWorktreeMap.get(resolvedWorktreePath);
    if (runtimeMatch) {
      match = runtimeMatch;
      reason = 'terminal runtime metadata worktreePath';
    }

    if (!match && entry.branchName) {
      const branchMatch = parseAfkIssueBranch(entry.branchName);
      if (branchMatch && terminalKeys.has(`${branchMatch.feature}/${branchMatch.issueName}`)) {
        match = branchMatch;
        reason = `terminal branch convention ${entry.branchName}`;
      }
    }

    if (!match) continue;
    const key = `${match.feature}/${match.issueName}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    targets.push({
      feature: match.feature,
      issueName: match.issueName,
      branchName: entry.branchName ?? branchFromConvention(match.feature, match.issueName),
      worktreePath: resolvedWorktreePath,
      reason: reason ?? 'terminal issue worktree',
    });
  }

  return targets;
}

function branchFromConvention(feature: string, issueName: string): string {
  return `afk/${feature}/${issueName}`;
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

function _readRuntimeMetadataRecord(
  repoRoot: string,
  feature: string,
  issueName: string,
): RuntimeMetadataRecord | null {
  const metadataPath = existingFilePath(ticketMetadataPath(repoRoot, feature, issueName));
  if (!metadataPath) return null;
  try {
    return JSON.parse(readFileSync(metadataPath, 'utf8')) as RuntimeMetadataRecord;
  } catch {
    return null;
  }
}

function _runtimeArtifactTarget(repoRoot: string, feature: string, issueName: string): RuntimeArtifactCleanupTarget {
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

function _isTerminalTicketStatus(status: string | undefined, runtime: RuntimeMetadataRecord | null): boolean {
  const normalized = normalize(status);
  const isFrontmatterTerminal = TERMINAL_STATUSES.has(normalized);
  // Preserve handoff/manual-review work even if frontmatter looks terminal
  if (runtime?.RUN_STATUS === 'handoff') return false;
  if (runtime?.IMPLEMENTATION_STATUS === 'completed' && runtime?.REVIEW_STATUS === 'unavailable') return false;
  return isFrontmatterTerminal;
}

function linearMirrorRoot(repoRoot: string): string {
  return path.resolve(repoRoot, '.scratch', '.opencode-afk-logs', 'linear-mirrors');
}

function _linearMirrorPath(repoRoot: string, runtime: RuntimeMetadataRecord | null): string | undefined {
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
    const sandcastleRuns = readSandcastleRuntimeRecords(this.input.repoRoot);
    const pendingPostMergeCleanupTargets = readPendingPostMergeCleanupItems(this.input.repoRoot);
    const terminalStatuses = new Set(['completed', 'failed', 'blocked', 'interrupted']);
    const terminalRuns = sandcastleRuns.filter(({ record }) => terminalStatuses.has(record.terminal.status));
    const preservedRuns = sandcastleRuns.filter(
      ({ record }) => record.terminal.status === 'running' || record.terminal.status === 'handoff',
    );
    const terminalKeys = new Set(
      terminalRuns.map(({ record }) => `${record.ticket.featureSlug}/${record.ticket.issueName}`),
    );
    const orphanedWorktreeTargets = _buildOrphanedWorktreeTargets(this.input.repoRoot, terminalKeys, sandcastleRuns);
    const sandcastleResourceTargets = terminalRuns.flatMap(({ record, recordPath }) =>
      record.cleanupResources.map((resource) => ({
        runId: record.runId,
        recordPath,
        feature: record.ticket.featureSlug,
        issueName: record.ticket.issueName,
        resource,
      })),
    );

    if (sandcastleRuns.length === 0) {
      return {
        terminalTargets: [],
        issueDeletionTargets: [],
        runtimeArtifactTargets: [],
        sandcastleResourceTargets: [],
        orphanedWorktreeTargets,
        pendingPostMergeCleanupTargets,
        preservedIssues: [],
        preservedArtifacts: [],
        featureDirectoriesToDelete: [],
      };
    }

    return {
      terminalTargets: terminalRuns
        .filter(({ record }) => isPathWithinScratch(this.input.repoRoot, record.ticket.ticketPath))
        .map(({ record }) => ({
          feature: record.ticket.featureSlug,
          issueName: record.ticket.issueName,
          issuePath: record.ticket.ticketPath,
          reason: `terminal Sandcastle run: ${record.terminal.status}`,
        })),
      issueDeletionTargets: [],
      runtimeArtifactTargets: [],
      sandcastleResourceTargets,
      orphanedWorktreeTargets,
      pendingPostMergeCleanupTargets,
      preservedIssues: preservedRuns
        .filter(({ record }) => isPathWithinScratch(this.input.repoRoot, record.ticket.ticketPath))
        .map(({ record }) => record.ticket.ticketPath),
      preservedArtifacts: [],
      featureDirectoriesToDelete: [],
    };
  }
}

function removeOrphanedWorktree(
  repoRoot: string,
  target: OrphanedWorktreeCleanupTarget,
): OrphanedWorktreeCleanupResult {
  const locked = checkWorktreeLocked(target.worktreePath);
  if (!locked.ok) {
    return { ...target, success: false, deletedBranch: false, deletedWorktree: false, warning: locked.reason };
  }
  const cleanWorktrees = checkBranchWorktreesClean(repoRoot, target.branchName);
  if (!cleanWorktrees.ok) {
    return { ...target, success: false, deletedBranch: false, deletedWorktree: false, warning: cleanWorktrees.reason };
  }

  const worktreeCleanup = removeWorktreesForBranch(repoRoot, target.branchName);
  if (!worktreeCleanup.success) {
    return {
      ...target,
      success: false,
      deletedBranch: false,
      deletedWorktree: worktreeCleanup.removedCount > 0,
      error: worktreeCleanup.error,
    };
  }

  let deletedBranch = false;
  try {
    runGit(repoRoot, ['branch', '-D', target.branchName]);
    deletedBranch = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('not found')) {
      return {
        ...target,
        success: false,
        deletedBranch: false,
        deletedWorktree: true,
        error: `branch delete failed: ${message}`,
      };
    }
  }

  return {
    ...target,
    success: true,
    deletedBranch,
    deletedWorktree: worktreeCleanup.removedCount > 0,
  };
}

function isPathWithinSandcastleRuntime(repoRoot: string, candidatePath: string): boolean {
  return isPathWithinRoot(path.resolve(candidatePath), path.resolve(repoRoot, '.scratch', 'sandcastle-runtime'));
}

function isPathWithinScratch(repoRoot: string, candidatePath: string | undefined): boolean {
  if (!candidatePath) return false;
  return isPathWithinRoot(path.resolve(candidatePath), path.resolve(repoRoot, '.scratch'));
}

function cleanupSandcastleResource(
  repoRoot: string,
  target: SandcastleCleanupResourceTarget,
): { deleted?: string; result: SandcastleCleanupResult } {
  const updatedAt = new Date().toISOString();
  const base = {
    resourceId: target.resource.id,
    resourceType: target.resource.type,
    updatedAt,
  };

  try {
    if (target.resource.type === 'log') {
      const logPath = target.resource.path;
      if (!logPath || !isPathWithinSandcastleRuntime(repoRoot, logPath)) {
        return { result: { ...base, status: 'skipped', message: 'log path is not under Sandcastle runtime root' } };
      }
      rmSync(logPath, { force: true, recursive: false });
      return { deleted: logPath, result: { ...base, status: 'succeeded' } };
    }

    if (target.resource.type === 'worktree') {
      const worktreePath = target.resource.path;
      if (!worktreePath || !isWithinRepoLocalWorktree(worktreePath, repoRoot)) {
        return { result: { ...base, status: 'skipped', message: 'worktree path is not a repo-local AFK worktree' } };
      }
      const locked = checkWorktreeLocked(worktreePath);
      if (!locked.ok) return { result: { ...base, status: 'skipped', message: locked.reason } };
      const clean = checkWorktreeClean(repoRoot, worktreePath);
      if (!clean.ok) return { result: { ...base, status: 'skipped', message: clean.reason } };
      runGit(repoRoot, ['worktree', 'remove', '-f', worktreePath]);
      return { deleted: worktreePath, result: { ...base, status: 'succeeded' } };
    }

    if (target.resource.type === 'branch') {
      const branchName = target.resource.id;
      if (!branchName.startsWith('afk/')) {
        return { result: { ...base, status: 'skipped', message: 'branch is not an AFK branch' } };
      }
      const clean = checkBranchWorktreesClean(repoRoot, branchName);
      if (!clean.ok) return { result: { ...base, status: 'skipped', message: clean.reason } };
      runGit(repoRoot, ['branch', '-D', branchName]);
      return { deleted: `branch ${branchName}`, result: { ...base, status: 'succeeded' } };
    }

    return {
      result: { ...base, status: 'skipped', message: `${target.resource.type} cleanup is not implemented locally` },
    };
  } catch (error) {
    return {
      result: {
        ...base,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function persistSandcastleCleanupResult(
  target: SandcastleCleanupResourceTarget,
  result: SandcastleCleanupResult,
): void {
  const record = JSON.parse(readFileSync(target.recordPath, 'utf8')) as SandcastleRuntimeRecord;
  const cleanupResults = [
    ...(record.cleanupResults ?? []).filter(
      (existing) => existing.resourceId !== result.resourceId || existing.resourceType !== result.resourceType,
    ),
    result,
  ];
  writeSandcastleRuntimeRecord(target.recordPath, { ...record, updatedAt: result.updatedAt, cleanupResults });
}

export class CleanupExecutor {
  execute(
    plan: CleanupPlan,
    repoRoot: string,
  ): {
    deleted: string[];
    postMergeCleanupResults: PendingPostMergeCleanupResult[];
    orphanedWorktreeResults: OrphanedWorktreeCleanupResult[];
  } {
    const deleted: string[] = [];
    const postMergeCleanupResults: PendingPostMergeCleanupResult[] = [];
    const orphanedWorktreeResults: OrphanedWorktreeCleanupResult[] = [];
    const remainingPending: PendingPostMergeCleanupItem[] = [];

    for (const target of plan.sandcastleResourceTargets ?? []) {
      const { deleted: deletedResource, result } = cleanupSandcastleResource(repoRoot, target);
      persistSandcastleCleanupResult(target, result);
      if (deletedResource) deleted.push(deletedResource);
    }

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

    for (const target of plan.orphanedWorktreeTargets) {
      const result = removeOrphanedWorktree(repoRoot, target);
      orphanedWorktreeResults.push(result);
      if (result.deletedWorktree) deleted.push(target.worktreePath);
      if (result.deletedBranch) deleted.push(`branch ${target.branchName}`);
    }

    const pathsToDelete = [
      ...plan.issueDeletionTargets.map((target) => target.issuePath),
      ...plan.runtimeArtifactTargets.flatMap((target) => [
        target.logPath,
        target.metadataPath,
        target.doneSentinelPath,
        target.failedSentinelPath,
        target.handoffSentinelPath,
      ]),
      ...plan.terminalTargets.map((target) => target.issuePath),
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
    return { deleted, postMergeCleanupResults, orphanedWorktreeResults };
  }
}
