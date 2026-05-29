import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FeatureLockProvider, FeatureMergeBackProvider } from './scheduler.js';
import type { WorktreePreparationService } from './worktree-preparation-service.js';
import { branchExists, runGit } from './worktree-preparation-service.js';

export class GitFeatureMergeBackProvider implements FeatureMergeBackProvider {
  constructor(
    private repoRoot: string,
    private checkouts: Record<string, ReturnType<WorktreePreparationService['prepare']>>,
  ) {}

  isWaveMerged(feature: string, _wave: number, issueNames: string[]): boolean {
    const featureCheckout = this.checkouts[feature];
    if (!featureCheckout) return false;
    for (const issueName of issueNames) {
      const ticketBranch = `afk/${feature}/${issueName}`;
      if (!branchExists(this.repoRoot, ticketBranch)) continue;
      try {
        runGit(this.repoRoot, ['merge-base', '--is-ancestor', ticketBranch, featureCheckout.effectiveBranchName]);
      } catch {
        return false;
      }
    }
    return true;
  }
}

export class GitFeatureLockProvider implements FeatureLockProvider {
  constructor(private checkouts: Record<string, ReturnType<WorktreePreparationService['prepare']>>) {}

  isLocked(feature: string): boolean {
    const checkout = this.checkouts[feature];
    if (!checkout) return false;
    const gitDir = resolveGitDir(checkout.worktreePath);
    if (existsSync(path.join(gitDir, 'MERGE_HEAD'))) return true;
    if (existsSync(path.join(gitDir, 'index.lock'))) return true;
    return false;
  }
}

export function resolveGitDir(worktreePath: string): string {
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
