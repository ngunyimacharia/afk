import type { PreparedCheckoutContext } from './worktree-preparation-service.js';

export interface PromptInput {
  checkout: PreparedCheckoutContext;
}

export function buildPrompt(input: PromptInput): string {
  return [
    '# AFK Prompt Instructions',
    '',
    'Use the prepared checkout context below as the deterministic workspace state before implementation starts.',
    `Feature slug: ${input.checkout.featureSlug}`,
    `Worktree: ${input.checkout.effectiveWorktreeName}`,
    `Branch: ${input.checkout.effectiveBranchName}`,
    `Worktree path: ${input.checkout.worktreePath}`,
    '',
    'Do not own worktree or branch setup in the prompt. The TypeScript orchestration has already prepared it.',
  ].join('\n');
}
