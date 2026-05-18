import { execFileSync } from 'node:child_process';
import type { GitContext, LaunchModel, LaunchPlan, ReviewerPromptTemplate, TicketRecord } from './types.js';
import type { PreparedCheckoutContext } from './worktree-preparation-service.js';

function recentCommits(repoRoot: string): string[] {
  try {
    return execFileSync('git', ['log', '-5', '--pretty=%h %s'], { cwd: repoRoot, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function buildLaunchPlan(
  repoRoot: string,
  model: LaunchModel,
  tickets: TicketRecord[],
  checkout: PreparedCheckoutContext,
  reviewer?: { model?: LaunchModel; prompt?: ReviewerPromptTemplate },
): LaunchPlan {
  return {
    repoRoot,
    model,
    reviewerModel: reviewer?.model,
    reviewerPrompt: reviewer?.prompt,
    tickets,
    checkout,
    gitContext: { commits: recentCommits(repoRoot) },
  };
}
