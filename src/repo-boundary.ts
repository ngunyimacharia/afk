import path from 'node:path';

export type RepoBoundaryClassification = 'inside-repo' | 'outside-repo' | 'unknown';

export interface RepoBoundaryResult {
  classification: RepoBoundaryClassification;
  repoRoot: string;
  target: string;
}

export function classifyPathAgainstRepoRoot(repoRoot: string, targetPath: string): RepoBoundaryResult {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const normalizedTarget = normalizePermissionPath(targetPath);
  if (!normalizedTarget) {
    return { classification: 'unknown', repoRoot: resolvedRepoRoot, target: targetPath };
  }

  const resolvedTarget = path.resolve(normalizedTarget);
  const relative = path.relative(resolvedRepoRoot, resolvedTarget);
  const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  return {
    classification: inside ? 'inside-repo' : 'outside-repo',
    repoRoot: resolvedRepoRoot,
    target: resolvedTarget,
  };
}

export function areAllPathsInsideRepoRoot(repoRoot: string, targets: readonly string[]): boolean {
  return (
    targets.length > 0 &&
    targets.every((target) => classifyPathAgainstRepoRoot(repoRoot, target).classification === 'inside-repo')
  );
}

export interface AfkWriteBoundaryInput {
  repoRoot: string;
  worktreePath: string;
  otherWorktreePaths?: readonly string[];
  targets: readonly string[];
}

export function areAllPathsAllowedForAfkWrite(input: AfkWriteBoundaryInput): boolean {
  return input.targets.length > 0 && input.targets.every((target) => isPathAllowedForAfkWrite(input, target));
}

export function isPathAllowedForAfkWrite(input: Omit<AfkWriteBoundaryInput, 'targets'>, target: string): boolean {
  const normalizedTarget = normalizePermissionPath(target);
  if (!normalizedTarget) return false;

  const resolvedTarget = path.resolve(normalizedTarget);
  const resolvedRepoRoot = path.resolve(input.repoRoot);
  const resolvedWorktree = path.resolve(input.worktreePath);
  const resolvedScratch = path.join(resolvedRepoRoot, '.scratch');

  if (isWithin(resolvedScratch, resolvedTarget)) return true;
  if (!isWithin(resolvedWorktree, resolvedTarget)) return false;

  return !(input.otherWorktreePaths ?? [])
    .map((worktreePath) => path.resolve(worktreePath))
    .some((worktreePath) => worktreePath !== resolvedWorktree && isWithin(worktreePath, resolvedTarget));
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizePermissionPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\*+$/g, '').replace(/[/]+$/g, '') || trimmed;
}
