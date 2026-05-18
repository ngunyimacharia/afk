import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

export interface PreparedCheckoutContext {
  featureSlug: string;
  defaultWorktreeName: string;
  effectiveWorktreeName: string;
  defaultBranchName: string;
  effectiveBranchName: string;
  worktreePath: string;
}

export interface WorktreePreparationInput {
  repoRoot: string;
  featureSlug: string;
  ticketOverrides?: { afk_worktree?: string; afk_branch?: string };
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

function directoryExists(targetPath: string): boolean {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function branchWorktreePath(repoRoot: string, branchName: string): string | null {
  try {
    const output = runGit(repoRoot, ['worktree', 'list', '--porcelain']);
    const lines = output.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index] === `branch refs/heads/${branchName}`) {
        return lines[index - 1]?.startsWith('worktree ') ? lines[index - 1].slice('worktree '.length) : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function ensureBranch(repoRoot: string, branchName: string): void {
  if (branchExists(repoRoot, branchName)) return;
  runGit(repoRoot, ['branch', '--no-track', branchName, 'HEAD']);
}

export class WorktreePreparationService {
  prepare(input: WorktreePreparationInput): PreparedCheckoutContext {
    const defaultWorktreeName = input.featureSlug;
    const effectiveWorktreeName = input.ticketOverrides?.afk_worktree?.trim() || defaultWorktreeName;
    const defaultBranchName = `afk/${defaultWorktreeName}`;
    const effectiveBranchName = input.ticketOverrides?.afk_branch?.trim() || defaultBranchName;
    const worktreePath = path.join(input.repoRoot, '..', `${effectiveWorktreeName}-worktree`);

    ensureBranch(input.repoRoot, effectiveBranchName);

    const existingWorktreePath = branchWorktreePath(input.repoRoot, effectiveBranchName);
    if (!existingWorktreePath && !worktreeExists(input.repoRoot, worktreePath) && !directoryExists(worktreePath) && !worktreePath.includes('undefined')) {
      runGit(input.repoRoot, ['worktree', 'add', worktreePath, effectiveBranchName]);
    }

    return {
      featureSlug: input.featureSlug,
      defaultWorktreeName,
      effectiveWorktreeName,
      defaultBranchName,
      effectiveBranchName,
      worktreePath,
    };
  }
}
