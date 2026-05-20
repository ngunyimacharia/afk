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
  const readinessLines = input.checkout.readiness
    ? [
      '',
      'Readiness metadata:',
      ...input.checkout.readiness.dependencyCopies.map((item) => `- ${item.name}: ${item.decision}`),
      `- .env.testing: ${input.checkout.readiness.envTestingCopy.decision}`,
      ...(input.checkout.readiness.checks ? [
        `- terminal state: ${input.checkout.readiness.checks.terminalState}`,
        `- tests: ${input.checkout.readiness.checks.testSuite.envTesting}${input.checkout.readiness.checks.testSuite.signals.length ? ` (${input.checkout.readiness.checks.testSuite.signals.join(', ')})` : ''}`,
        `- smoke: ${input.checkout.readiness.checks.smoke.status}${input.checkout.readiness.checks.smoke.command ? ` (${input.checkout.readiness.checks.smoke.command})` : ''}`,
        ...input.checkout.readiness.checks.staticStyleChecks.map((item) => `- static/style: ${item.status}${item.command ? ` (${item.command})` : ''}`),
      ] : []),
    ]
    : [];
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
    ...readinessLines,
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
