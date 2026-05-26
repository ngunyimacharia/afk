import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { AfkProjectConfig } from './project-config.js';
import type { PreparedCheckoutContext } from './worktree-preparation-service.js';
import {
  branchExists,
  branchWorktreePath,
  copyReadinessArtifacts,
  ensureBranch,
  ensureIgnoredWorktreeRoot,
  runGit,
  staleWorktreePathMessage,
  worktreeExists,
} from './worktree-preparation-service.js';

export interface ScratchWorktreeInput {
  repoRoot: string;
  featureSlug: string;
  issueName: string;
  baseRef?: string;
  projectConfig?: AfkProjectConfig;
}

export class ScratchWorktreeService {
  createScratchWorktree(input: ScratchWorktreeInput): PreparedCheckoutContext {
    const defaultWorktreeName = `${input.featureSlug}-${input.issueName}`;
    const effectiveWorktreeName = defaultWorktreeName;
    const defaultBranchName = `afk/${input.featureSlug}/${input.issueName}`;
    const effectiveBranchName = defaultBranchName;
    const worktreePath = path.join(ensureIgnoredWorktreeRoot(input.repoRoot), effectiveWorktreeName);

    const baseRef = input.baseRef ?? (branchExists(input.repoRoot, input.featureSlug) ? input.featureSlug : 'HEAD');

    const existingWorktreePath = branchWorktreePath(input.repoRoot, effectiveBranchName);
    const registeredWorktree = worktreeExists(input.repoRoot, worktreePath);
    if (!existingWorktreePath && !registeredWorktree && existsSync(worktreePath)) {
      throw new Error(staleWorktreePathMessage(worktreePath));
    }

    const worktreeAlreadyExists = Boolean(existingWorktreePath) || registeredWorktree;

    if (!worktreeAlreadyExists) {
      ensureBranch(input.repoRoot, effectiveBranchName, baseRef);
      runGit(input.repoRoot, ['worktree', 'add', worktreePath, effectiveBranchName]);
    }

    const readiness = copyReadinessArtifacts(input.repoRoot, worktreePath, input.projectConfig);

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

  removeScratchWorktree(context: PreparedCheckoutContext): void {
    const repoRoot = path.resolve(context.worktreePath, '..', '..');

    if (worktreeExists(repoRoot, context.worktreePath)) {
      runGit(repoRoot, ['worktree', 'remove', '-f', context.worktreePath]);
    }

    if (existsSync(context.worktreePath)) {
      rmSync(context.worktreePath, { recursive: true, force: true });
    }

    if (branchExists(repoRoot, context.effectiveBranchName)) {
      runGit(repoRoot, ['branch', '-D', context.effectiveBranchName]);
    }
  }
}
