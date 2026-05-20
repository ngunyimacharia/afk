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
  return { classification: inside ? 'inside-repo' : 'outside-repo', repoRoot: resolvedRepoRoot, target: resolvedTarget };
}

export function areAllPathsInsideRepoRoot(repoRoot: string, targets: readonly string[]): boolean {
  return targets.length > 0 && targets.every((target) => classifyPathAgainstRepoRoot(repoRoot, target).classification === 'inside-repo');
}

function normalizePermissionPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\*+$/g, '').replace(/[\/]+$/g, '') || trimmed;
}
