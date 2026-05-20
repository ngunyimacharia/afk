import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildWorktreeReadiness, detectTestSuite, type ReadinessCheckMetadata, type ReadinessCommandExecutor } from './readiness-service.js';

export interface PreparedCheckoutContext {
  featureSlug: string;
  defaultWorktreeName: string;
  effectiveWorktreeName: string;
  defaultBranchName: string;
  effectiveBranchName: string;
  worktreePath: string;
  readiness?: WorktreeReadinessMetadata;
}

export const DEPENDENCY_COPY_ALLOWLIST = ['vendor', 'node_modules', '.venv', 'venv'] as const;

type ReadinessDecision = 'copied' | 'missing-source' | 'already-present' | 'blocked-external-symlink';

export interface ReadinessCopyRecord {
  name: string;
  decision: ReadinessDecision;
  sourcePath: string;
  targetPath: string;
  note?: string;
}

export interface WorktreeReadinessMetadata {
  dependencyCopies: ReadinessCopyRecord[];
  envTestingCopy: ReadinessCopyRecord;
  checks?: ReadinessCheckMetadata;
}

export interface WorktreePreparationInput {
  repoRoot: string;
  featureSlug: string;
  ticketOverrides?: { afk_worktree?: string; afk_branch?: string };
  baseRef?: string;
  selectedTicketPaths?: string[];
  testsDisabledByUser?: boolean;
  readinessExecutor?: ReadinessCommandExecutor;
}

export class WorktreeReadinessBlockedError extends Error {
  constructor(message: string, readonly readiness: ReadinessCheckMetadata) {
    super(message);
  }
}

export function needsDisabledTestsDecision(repoRoot: string): boolean {
  return detectTestSuite(repoRoot).detected && !existsSync(path.join(repoRoot, '.env.testing'));
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function evaluateCopyCandidate(params: {
  repoRootReal: string;
  sourcePath: string;
  targetPath: string;
  name: string;
  allowSymlink: boolean;
}): ReadinessCopyRecord {
  if (!existsSync(params.sourcePath)) {
    return {
      name: params.name,
      decision: 'missing-source',
      sourcePath: params.sourcePath,
      targetPath: params.targetPath,
    };
  }
  if (existsSync(params.targetPath)) {
    return {
      name: params.name,
      decision: 'already-present',
      sourcePath: params.sourcePath,
      targetPath: params.targetPath,
    };
  }

  const stat = lstatSync(params.sourcePath);
  if (stat.isSymbolicLink()) {
    const resolvedSource = realpathSync(params.sourcePath);
    if (!pathWithin(params.repoRootReal, resolvedSource)) {
      return {
        name: params.name,
        decision: 'blocked-external-symlink',
        sourcePath: params.sourcePath,
        targetPath: params.targetPath,
        note: `Resolved symlink target outside source checkout: ${resolvedSource}`,
      };
    }
    if (!params.allowSymlink) {
      return {
        name: params.name,
        decision: 'blocked-external-symlink',
        sourcePath: params.sourcePath,
        targetPath: params.targetPath,
        note: 'Symlinked source not allowlisted for this artifact type.',
      };
    }
  }

  cpSync(params.sourcePath, params.targetPath, { recursive: true });
  return {
    name: params.name,
    decision: 'copied',
    sourcePath: params.sourcePath,
    targetPath: params.targetPath,
  };
}

function copyReadinessArtifacts(repoRoot: string, worktreePath: string): WorktreeReadinessMetadata {
  const repoRootReal = realpathSync(repoRoot);
  const dependencyCopies = DEPENDENCY_COPY_ALLOWLIST.map((name) => evaluateCopyCandidate({
    repoRootReal,
    sourcePath: path.join(repoRoot, name),
    targetPath: path.join(worktreePath, name),
    name,
    allowSymlink: true,
  }));

  const envTestingCopy = evaluateCopyCandidate({
    repoRootReal,
    sourcePath: path.join(repoRoot, '.env.testing'),
    targetPath: path.join(worktreePath, '.env.testing'),
    name: '.env.testing',
    allowSymlink: false,
  });

  return { dependencyCopies, envTestingCopy };
}

function runGit(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function branchExists(repoRoot: string, branchName: string): boolean {
  try {
    runGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

function worktreeExists(repoRoot: string, worktreePath: string): boolean {
  try {
    const output = runGit(repoRoot, ['worktree', 'list', '--porcelain']);
    return output.split('\n').some((line) => line === `worktree ${worktreePath}`);
  } catch {
    return false;
  }
}

function staleWorktreePathMessage(worktreePath: string): string {
  return `Worktree path already exists but is not registered with git: ${worktreePath}. Resolve the stale repo-local path with a dedicated cleanup step before rerunning AFK.`;
}

function branchWorktreePath(repoRoot: string, branchName: string): string | null {
  try {
    const output = runGit(repoRoot, ['worktree', 'list', '--porcelain']);
    const lines = output.split('\n');
    let currentWorktreePath: string | null = null;
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].startsWith('worktree ')) currentWorktreePath = lines[index].slice('worktree '.length);
      if (lines[index] === `branch refs/heads/${branchName}`) {
        return currentWorktreePath;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function ensureBranch(repoRoot: string, branchName: string, baseRef = 'HEAD'): void {
  if (branchExists(repoRoot, branchName)) return;
  runGit(repoRoot, ['branch', '--no-track', branchName, baseRef]);
}

function ensureIgnoredWorktreeRoot(repoRoot: string): string {
  const worktreeRoot = path.join(repoRoot, '.worktree');
  mkdirSync(worktreeRoot, { recursive: true });
  const gitignorePath = path.join(repoRoot, '.gitignore');
  const entry = '.worktree/';
  const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(entry) || lines.includes('.worktree')) return worktreeRoot;
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  writeFileSync(gitignorePath, `${current}${prefix}${entry}\n`, 'utf8');
  return worktreeRoot;
}

export class WorktreePreparationService {
  prepare(input: WorktreePreparationInput): PreparedCheckoutContext {
    const defaultWorktreeName = input.featureSlug;
    const effectiveWorktreeName = input.ticketOverrides?.afk_worktree?.trim() || defaultWorktreeName;
    const defaultBranchName = `afk/${defaultWorktreeName}`;
    const effectiveBranchName = input.ticketOverrides?.afk_branch?.trim() || defaultBranchName;
    const worktreePath = path.join(ensureIgnoredWorktreeRoot(input.repoRoot), effectiveWorktreeName);

    ensureBranch(input.repoRoot, effectiveBranchName, input.baseRef);

    const existingWorktreePath = branchWorktreePath(input.repoRoot, effectiveBranchName);
    const registeredWorktree = worktreeExists(input.repoRoot, worktreePath);
    if (!existingWorktreePath && !registeredWorktree && existsSync(worktreePath)) {
      throw new Error(staleWorktreePathMessage(worktreePath));
    }
    if (!existingWorktreePath && !registeredWorktree && !worktreePath.includes('undefined')) {
      runGit(input.repoRoot, ['worktree', 'add', worktreePath, effectiveBranchName]);
    }

    const readiness = copyReadinessArtifacts(input.repoRoot, worktreePath);
    const envTestingDecision = readiness.envTestingCopy.decision === 'copied' || readiness.envTestingCopy.decision === 'already-present'
      ? 'present'
      : needsDisabledTestsDecision(input.repoRoot)
        ? input.testsDisabledByUser ? 'missing-disabled-by-user' : 'missing-blocking'
        : 'not-required';
    readiness.checks = buildWorktreeReadiness({
      repoRoot: input.repoRoot,
      worktreePath,
      expectedBranch: effectiveBranchName,
      selectedTicketPaths: input.selectedTicketPaths,
      envTestingDecision,
      dependencyCopyStatusKnown: Boolean(readiness.dependencyCopies.length && readiness.envTestingCopy),
      executor: input.readinessExecutor,
    });
    if (readiness.checks.terminalState === 'blocked') {
      throw new WorktreeReadinessBlockedError(readiness.checks.blockReason ?? 'Worktree readiness failed', readiness.checks);
    }

    return {
      featureSlug: input.featureSlug,
      defaultWorktreeName,
      effectiveWorktreeName,
      defaultBranchName,
      effectiveBranchName,
      worktreePath,
      readiness,
    };
  }
}
