import type { CheckoutContext, ReviewerPromptTemplate, TicketRecord } from './types.js';

export interface PromptInput {
  checkout: CheckoutContext;
  ticket: TicketRecord;
  ticketContent: string;
  afkInstructions?: string;
  reviewerPrompt?: ReviewerPromptTemplate;
}

const DEFAULT_AFK_INSTRUCTIONS = [
  '# AFK Prompt Instructions',
  '',
  'You are running in fully autonomous AFK mode. Implement the provided ticket without human intervention.',
  '',
  'Before exiting, update the provided ticket file with the final tracker status and append a structured `## AFK Summary` block.',
].join('\n');

export function buildPrompt(input: PromptInput): string {
  return [
    input.afkInstructions?.trim() || DEFAULT_AFK_INSTRUCTIONS,
    '',
    '## Runtime Context',
    '',
    'Use the prepared checkout context below as the deterministic workspace state before implementation starts.',
    `Feature slug: ${input.checkout.featureSlug}`,
    `Worktree: ${input.checkout.effectiveWorktreeName}`,
    `Branch: ${input.checkout.effectiveBranchName}`,
    `Worktree path: ${input.checkout.worktreePath}`,
    '',
    'Do not own worktree or branch setup in the prompt. The TypeScript orchestration has already prepared it.',
    '',
    '## Ticket Update Contract',
    '',
    `Ticket file to update: ${input.ticket.path}`,
    `Issue reference: ${input.ticket.label}`,
    '',
    'Before exiting, edit that ticket file directly. Do not put the final AFK summary only in the assistant response, runtime log, or commit message.',
    'If the ticket is complete, set its `Status:` line to `done` and append/update the `## AFK Summary` section in that file.',
    '',
    ...(input.reviewerPrompt ? ['## Reviewer Context', '', `Reviewer prompt: ${input.reviewerPrompt.id} (${input.reviewerPrompt.path})`, ''] : []),
    '## Ticket Content',
    '',
    '```markdown',
    input.ticketContent.trimEnd(),
    '```',
  ].join('\n');
}
