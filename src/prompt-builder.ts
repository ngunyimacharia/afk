import type { AfkStateSnapshot, CheckoutContext, ReviewerPromptTemplate, TicketRecord } from './types.js';

export interface PromptInput {
  checkout: CheckoutContext;
  ticket: TicketRecord;
  ticketContent: string;
  afkInstructions?: string;
  reviewerPrompt?: ReviewerPromptTemplate;
  snapshot?: AfkStateSnapshot;
}

const DEFAULT_AFK_INSTRUCTIONS = [
  '# AFK Prompt Instructions',
  '',
  'You are running in fully autonomous AFK mode. Implement the provided ticket without human intervention.',
  '',
  'Before exiting, update the provided ticket file with the final tracker status and append a structured `## AFK Summary` block.',
].join('\n');

export function buildPrompt(input: PromptInput): string {
  const snapshotLines = buildSnapshotLines(input.snapshot);
  return [
    input.afkInstructions?.trim() || DEFAULT_AFK_INSTRUCTIONS,
    '',
    '## Runtime Context',
    '',
    'Use this prepared checkout. Do not create or switch worktrees.',
    `Repo root: ${input.snapshot?.repoRoot ?? 'unknown'}`,
    `Feature slug: ${input.checkout.featureSlug}`,
    `Branch: ${input.checkout.effectiveBranchName}`,
    `Worktree path: ${input.checkout.worktreePath}`,
    'Access policy: paths inside the repo root are allowed, including cross-worktree paths. Paths outside the repo root are not allowed.',
    'Search policy: search only inside the repo root. If a search reports macOS Operation not permitted paths, rerun it scoped to the repo root.',
    '',
    ...snapshotLines,
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

function buildSnapshotLines(snapshot?: AfkStateSnapshot): string[] {
  if (!snapshot) {
    return [];
  }
  const dependencyLines = snapshot.dependencies.length
    ? snapshot.dependencies.flatMap((dependency) => [
      `- ${dependency.label}: ticket status=${dependency.status}; runtime=${dependency.runtimeStatus}; done sentinel=${dependency.doneSentinel}; failed sentinel=${dependency.failedSentinel}`,
      `  instruction: if ${dependency.label} is already done, do not implement it again.`,
    ])
    : [];
  return [
    ...(dependencyLines.length ? ['## Dependencies', '',] : []),
    ...dependencyLines,
  ];
}
