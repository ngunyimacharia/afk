import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EnvironmentReadinessChecker } from './environment-readiness-checker.js';
import { resolveExecutable } from './executable-resolution.js';
import type { AfkProjectConfig } from './project-config.js';
import {
  buildWorktreeReadiness,
  detectTestSuite,
  type ReadinessCheckMetadata,
  type ReadinessCommandExecutor,
  runReadinessCommands,
} from './readiness-service.js';

export type BranchNameSource = 'linear' | 'override' | 'fallback';

export interface PreparedCheckoutContext {
  featureSlug: string;
  defaultWorktreeName: string;
  effectiveWorktreeName: string;
  defaultBranchName: string;
  effectiveBranchName: string;
  branchNameSource: BranchNameSource;
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
  linearIssueKey?: string;
  linearIssueBranchName?: string | null;
  ticketOverrides?: { afk_worktree?: string; afk_branch?: string };
  baseRef?: string;
  selectedTicketPaths?: string[];
  testsDisabledByUser?: boolean;
  projectConfig?: AfkProjectConfig;
  readinessExecutor?: ReadinessCommandExecutor;
}

export function pathSafeCheckoutName(value: string): string {
  return value
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

export function isSafeCheckoutBranchName(value?: string | null): value is string {
  const branchName = value?.trim();
  if (!branchName) return false;
  if (branchName.includes('..') || branchName.includes('@{') || branchName.endsWith('.')) return false;
  if (/^[/.]|[/.]$/.test(branchName) || /[\\\s~^:?*[\]]/.test(branchName)) return false;
  if ([...branchName].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    return false;
  }
  return branchName
    .split('/')
    .every((segment) => segment && segment !== '.' && segment !== '..' && !segment.endsWith('.lock'));
}

export function linearFallbackBranchName(issueKey: string): string {
  return `afk/${pathSafeCheckoutName(issueKey)}`;
}

export class WorktreeReadinessBlockedError extends Error {
  constructor(
    message: string,
    readonly readiness: ReadinessCheckMetadata,
  ) {
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

export function copyReadinessArtifacts(
  repoRoot: string,
  worktreePath: string,
  config?: AfkProjectConfig,
): WorktreeReadinessMetadata {
  const repoRootReal = realpathSync(repoRoot);
  const dependencyCopies = DEPENDENCY_COPY_ALLOWLIST.map((name) =>
    evaluateCopyCandidate({
      repoRootReal,
      sourcePath: path.join(repoRoot, name),
      targetPath: path.join(worktreePath, name),
      name,
      allowSymlink: true,
    }),
  );

  const envFile = config?.testEnvFile?.trim() || '.env.testing';
  const envTestingCopy = evaluateCopyCandidate({
    repoRootReal,
    sourcePath: path.join(repoRoot, envFile),
    targetPath: path.join(worktreePath, envFile),
    name: envFile,
    allowSymlink: false,
  });

  return { dependencyCopies, envTestingCopy };
}

export function runGit(repoRoot: string, args: string[]): string {
  const gitPath = resolveExecutable('git');
  return execFileSync(gitPath, args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

export function branchExists(repoRoot: string, branchName: string): boolean {
  try {
    runGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

export function worktreeExists(repoRoot: string, worktreePath: string): boolean {
  try {
    const output = runGit(repoRoot, ['worktree', 'list', '--porcelain']);
    return output.split('\n').some((line) => line === `worktree ${worktreePath}`);
  } catch {
    return false;
  }
}

export function staleWorktreePathMessage(worktreePath: string): string {
  return `Worktree path already exists but is not registered with git: ${worktreePath}. Resolve the stale repo-local path with a dedicated cleanup step before rerunning AFK.`;
}

export function branchWorktreePath(repoRoot: string, branchName: string): string | null {
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

export function ensureBranch(repoRoot: string, branchName: string, baseRef = 'HEAD'): void {
  if (branchExists(repoRoot, branchName)) return;
  runGit(repoRoot, ['branch', '--no-track', branchName, baseRef]);
}

export function ensureIgnoredWorktreeRoot(repoRoot: string): string {
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
    const defaultBranchName = input.linearIssueKey ? linearFallbackBranchName(input.linearIssueKey) : input.featureSlug;
    const overrideBranch = input.ticketOverrides?.afk_branch?.trim();
    const linearBranch = isSafeCheckoutBranchName(input.linearIssueBranchName)
      ? input.linearIssueBranchName.trim()
      : null;
    const effectiveBranchName = overrideBranch || linearBranch || defaultBranchName;
    const branchNameSource: BranchNameSource = overrideBranch ? 'override' : linearBranch ? 'linear' : 'fallback';
    const defaultWorktreeName = pathSafeCheckoutName(effectiveBranchName) || input.featureSlug;
    const effectiveWorktreeName = input.ticketOverrides?.afk_worktree?.trim() || defaultWorktreeName;
    const worktreePath = path.join(ensureIgnoredWorktreeRoot(input.repoRoot), effectiveWorktreeName);

    const environmentReadiness = new EnvironmentReadinessChecker(input.readinessExecutor).check(
      input.repoRoot,
      input.projectConfig,
    );
    if (environmentReadiness.status === 'failed') {
      const blockReason = environmentReadiness.reason ?? 'environment readiness failed';
      const syntheticMetadata: ReadinessCheckMetadata = {
        worktreePath: { status: 'blocked', path: worktreePath, reason: 'worktree path does not exist' },
        branch: { status: 'blocked', expected: effectiveBranchName, reason: 'expected branch is not checked out' },
        ticketPaths: { status: 'passed', missing: [] },
        gitIndexLock: { status: 'passed', path: path.join(worktreePath, '.git', 'index.lock') },
        dependencyCopyStatusKnown: { status: 'passed' },
        testSuite: { detected: false, signals: [], envTesting: 'not-required' },
        environmentReadiness,
        smoke: { command: '', mode: 'smoke', status: 'skipped', reason: blockReason },
        staticStyleChecks: [],
        terminalState: 'blocked',
        blockReason,
      };
      throw new WorktreeReadinessBlockedError(blockReason, syntheticMetadata);
    }

    ensureBranch(input.repoRoot, effectiveBranchName, input.baseRef);

    const existingWorktreePath = branchWorktreePath(input.repoRoot, effectiveBranchName);
    const registeredWorktree = worktreeExists(input.repoRoot, worktreePath);
    if (!existingWorktreePath && !registeredWorktree && existsSync(worktreePath)) {
      throw new Error(staleWorktreePathMessage(worktreePath));
    }

    const worktreeAlreadyExists = Boolean(existingWorktreePath) || registeredWorktree;

    if (!worktreeAlreadyExists) {
      const { smoke, staticStyleChecks } = runReadinessCommands({
        cwd: input.repoRoot,
        config: input.projectConfig,
        executor: input.readinessExecutor,
      });
      const failed = [smoke, ...staticStyleChecks].find((item) => item.status === 'failed');
      if (failed) {
        const blockReason = `${failed.mode} readiness failed: ${failed.command}`;
        const syntheticMetadata: ReadinessCheckMetadata = {
          worktreePath: { status: 'blocked', path: worktreePath, reason: 'worktree path does not exist' },
          branch: { status: 'blocked', expected: effectiveBranchName, reason: 'expected branch is not checked out' },
          ticketPaths: { status: 'passed', missing: [] },
          gitIndexLock: { status: 'passed', path: path.join(worktreePath, '.git', 'index.lock') },
          dependencyCopyStatusKnown: { status: 'passed' },
          testSuite: { detected: false, signals: [], envTesting: 'not-required' },
          smoke,
          staticStyleChecks,
          terminalState: 'blocked',
          blockReason,
        };
        throw new WorktreeReadinessBlockedError(blockReason, syntheticMetadata);
      }
    }

    if (!existingWorktreePath && !registeredWorktree && !worktreePath.includes('undefined')) {
      runGit(input.repoRoot, ['worktree', 'add', worktreePath, effectiveBranchName]);
    }

    const readiness = copyReadinessArtifacts(input.repoRoot, worktreePath, input.projectConfig);
    const envTestingDecision =
      readiness.envTestingCopy.decision === 'copied' || readiness.envTestingCopy.decision === 'already-present'
        ? 'present'
        : input.projectConfig
          ? 'not-required'
          : needsDisabledTestsDecision(input.repoRoot)
            ? input.testsDisabledByUser
              ? 'missing-disabled-by-user'
              : 'missing-blocking'
            : 'not-required';
    readiness.checks = buildWorktreeReadiness({
      repoRoot: input.repoRoot,
      worktreePath,
      expectedBranch: effectiveBranchName,
      selectedTicketPaths: input.selectedTicketPaths,
      envTestingDecision,
      dependencyCopyStatusKnown: Boolean(readiness.dependencyCopies.length && readiness.envTestingCopy),
      config: input.projectConfig,
      executor: input.readinessExecutor,
      skipCommandChecks: worktreeAlreadyExists,
      environmentReadiness,
    });
    if (readiness.checks.terminalState === 'blocked') {
      throw new WorktreeReadinessBlockedError(
        readiness.checks.blockReason ?? 'Worktree readiness failed',
        readiness.checks,
      );
    }

    return {
      featureSlug: input.featureSlug,
      defaultWorktreeName,
      effectiveWorktreeName,
      defaultBranchName,
      effectiveBranchName,
      branchNameSource,
      worktreePath,
      readiness,
    };
  }
}
