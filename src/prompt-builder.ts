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
    '## CRITICAL: Final Result Sentinel',
    '',
    'Your final assistant message MUST contain the exact line `AFK_TICKET_RESULT: success` when the ticket is complete.',
    'If this line is missing, the run will be marked FAILED even if all work is correct.',
    'Output this sentinel line FIRST in your final message, before any human-readable summary.',
    '',
    input.afkInstructions?.trim() || DEFAULT_AFK_INSTRUCTIONS,
    '',
    '## Runtime Context',
    '',
    'Use this prepared checkout. Do not create or switch worktrees.',
    `Working checkout: ${input.checkout.worktreePath}`,
    `Feature slug: ${input.checkout.featureSlug}`,
    `Branch: ${input.checkout.effectiveBranchName}`,
    `Worktree path: ${input.checkout.worktreePath}`,
    `Repo root, for shared scratch artifacts only: ${input.snapshot?.repoRoot ?? 'unknown'}`,
    'Access policy: source-code reads, searches, tests, and edits must use the Working checkout. Source mutation outside the Working checkout is forbidden.',
    'Root repo writes are allowed only under the listed shared .scratch artifact paths. Do not write root source files when the root differs from the Working checkout.',
    'Do not read, write, or patch source files in any other worktree.',
    'Search policy: search only inside the Working checkout unless reading the listed shared .scratch artifacts.',
    '',
    ...snapshotLines,
    '',
    '## Ticket Update Contract',
    '',
    `Ticket file to update: ${input.ticket.path}`,
    `Issue reference: ${input.ticket.label}`,
    '',
    'Before exiting, edit that ticket file directly. Do not put the final AFK summary only in the assistant response, runtime log, or commit message.',
    'If the ticket is complete, set its YAML frontmatter `status` field to `done` and append/update the `## AFK Summary` section in that file.',
    '',
    '## Final Result Contract',
    '',
    'When and only when the ticket is complete, tests/verification have been run or documented, the ticket file has been updated, and all required commits are created, start your final assistant message with this exact line:',
    'AFK_TICKET_RESULT: success',
    '',
    'Place this line BEFORE any human-readable summary. Do not bury it at the end.',
    '',
    'If the ticket is incomplete, blocked, or failed, do not include the success line. Start your final assistant message with these exact lines instead:',
    'AFK_TICKET_RESULT: failed',
    'Reason: <short reason>',
    '',
    ...(input.reviewerPrompt
      ? ['## Reviewer Context', '', `Reviewer prompt: ${input.reviewerPrompt.id} (${input.reviewerPrompt.path})`, '']
      : []),
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
    '## Shared Scratch Artifacts',
    '',
    `- Scratch feature path: ${snapshot.scratchFeaturePath}`,
    ...(snapshot.featurePrdPath ? [`- Feature PRD: ${snapshot.featurePrdPath}`] : []),
    '- Read or update scratch artifacts only at these absolute paths. Do not guess `.scratch` paths relative to the worktree.',
    '',
    ...(dependencyLines.length ? ['## Dependencies', ''] : []),
    ...dependencyLines,
  ];
}
