import { type ScratchWorktreeInput, ScratchWorktreeService } from './scratch-worktree-service.js';
import type { PreparedCheckoutContext } from './worktree-preparation-service.js';

export interface SandcastleTicketWorktreeInput extends ScratchWorktreeInput {}

export interface SandcastlePreservedWorktree {
  branch: string;
  worktreePath: string;
  reason: string;
}

export interface SandcastleTicketWorktreeService {
  createTicketWorktree(input: SandcastleTicketWorktreeInput): PreparedCheckoutContext;
  preserveFailedWorktree(context: PreparedCheckoutContext, reason: string): SandcastlePreservedWorktree;
}

export class SandcastleWorktreeService implements SandcastleTicketWorktreeService {
  // Temporary fallback until AFK can call a concrete Sandcastle branch/worktree API.
  constructor(private readonly fallback = new ScratchWorktreeService()) {}

  createTicketWorktree(input: SandcastleTicketWorktreeInput): PreparedCheckoutContext {
    return this.fallback.createScratchWorktree({
      ...input,
      linearIssueKey: undefined,
      linearIssueBranchName: null,
    });
  }

  preserveFailedWorktree(context: PreparedCheckoutContext, reason: string): SandcastlePreservedWorktree {
    return {
      branch: context.effectiveBranchName,
      worktreePath: context.worktreePath,
      reason,
    };
  }
}
