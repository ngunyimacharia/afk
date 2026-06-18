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
  'Before exiting, update the local run result artifact named by Runtime Context with final tracker status and reviewer-ready summary details.',
].join('\n');

export function buildPrompt(input: PromptInput): string {
  const snapshotLines = buildSnapshotLines(input.snapshot);
  const updateContractLines = buildTicketUpdateContractLines(input.ticket);
  const completionChecklistLines = buildCompletionChecklistLines(input.ticket);
  return [
    input.afkInstructions?.trim() || DEFAULT_AFK_INSTRUCTIONS,
    '',
    '## Runtime Context',
    '',
    'Use this prepared checkout. Do not create or switch worktrees.',
    `Working checkout: ${input.checkout.worktreePath}`,
    `Feature slug: ${input.checkout.featureSlug}`,
    `Branch: ${input.checkout.effectiveBranchName}`,
    `Worktree path: ${input.checkout.worktreePath}`,
    ...(input.snapshot?.head ? [`Implementation HEAD: ${input.snapshot.head}`] : []),
    'Shell commands: always run tests, linters, builds, and git from the Worktree path. Use absolute paths or the workdir parameter. Never assume the default working directory is the worktree.',
    `Repo root, for shared scratch artifacts only: ${input.snapshot?.repoRoot ?? 'unknown'}`,
    'Authorization: repo-local reads, edits, tests, staging, and commits are explicitly allowed inside the Working checkout for this ticket.',
    'Do not refuse solely because this task requires modifying and committing a local repository; the prepared checkout is the AFK execution sandbox.',
    'Do not ask the operator to reply with `proceed`, `continue`, approval, or confirmation. If tools are available, continue directly with the required reads, edits, tests, ticket update, and commit.',
    'Access policy: source-code reads, searches, tests, and edits must use the Working checkout. Source mutation outside the Working checkout is forbidden.',
    'Root repo writes are allowed only under the listed shared .scratch artifact paths. Do not write root source files when the root differs from the Working checkout.',
    'Do not read, write, or patch source files in any other worktree.',
    'Search policy: search only inside the Working checkout unless reading the listed shared .scratch artifacts.',
    '',
    ...snapshotLines,
    '',
    ...updateContractLines,
    '',
    ...completionChecklistLines,
    ...(completionChecklistLines.length ? [''] : []),
    '## Verification Budget',
    '',
    '1. Run the verification commands listed in the ticket.',
    '2. After final changes are committed and verification passes once, do not rerun the same passing tests again.',
    '3. Record verification evidence in the `## AFK Summary` section.',
    '4. If verification fails on the first attempt, fix the issue and rerun only the failing verification. Do not rerun already-passing verification suites.',
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

function buildCompletionChecklistLines(ticket: TicketRecord): string[] {
  if ((ticket.provider?.kind ?? 'scratch') !== 'scratch') return [];
  return [
    '## Scratch Artifact Completion Checklist',
    '',
    'Before exiting, confirm ALL of the following:',
    '- [ ] The ticket YAML frontmatter `status` field is NOT set to `done`. Leave it in its current working state (e.g., `ready-for-agent`). The reviewer will set it to `done` after approval.',
    '- [ ] The ticket file contains an `## AFK Summary` section with a `### Reviewer Notes` subsection.',
    '- [ ] The `### Reviewer Notes` subsection covers: changes made, tests run, caveats or risks, and follow-ups useful to the reviewer.',
    '- [ ] Any scratch artifacts created are local-only under `.scratch/` and are NOT committed to the repo.',
    '- [ ] Source code changes are committed using conventional commits.',
    '- [ ] Commit messages contain no AI, model, Claude, opencode, `Co-Authored-By`, `Generated-By`, or similar attribution.',
    '- [ ] The PRD or feature spec is updated only if the ticket explicitly requires it.',
  ];
}

function buildTicketUpdateContractLines(ticket: TicketRecord): string[] {
  const providerKind = ticket.provider?.kind ?? 'scratch';
  if (providerKind === 'scratch') {
    return [
      '## Ticket Update Contract',
      '',
      `Ticket file to update: ${ticket.path}`,
      `Issue reference: ${ticket.label}`,
      '',
      'Before exiting, edit that ticket file directly. Do not put the final AFK summary only in the assistant response, runtime log, or commit message.',
      'Do NOT set the YAML frontmatter `status` field to `done`. The reviewer will set the final status after review.',
      'Append/update the `## AFK Summary` section in that file.',
      'The `## AFK Summary` section MUST include a `### Reviewer Notes` subsection that covers: changes made, tests run, caveats or risks, and follow-ups useful to the reviewer.',
    ];
  }

  const mirrorPath = ticket.provider?.materializedFiles?.ticketPath ?? ticket.path;
  const summaryPath = ticket.provider?.materializedFiles?.runSummaryPath;
  return [
    '## Provider Result Contract',
    '',
    `Source tracker provider: ${providerKind}`,
    `Issue reference: ${ticket.label}`,
    ...(ticket.provider?.displayId ? [`Provider display ID: ${ticket.provider.displayId}`] : []),
    ...(ticket.provider?.url ? [`Provider URL: ${ticket.provider.url}`] : []),
    ...(mirrorPath ? [`Managed local mirror: ${mirrorPath}`] : []),
    ...(summaryPath ? [`Run summary artifact: ${summaryPath}`] : []),
    '',
    'Before exiting, update the managed local mirror or run summary artifact with reviewer-ready AFK summary details.',
    'Do NOT mark the ticket as done in the source tracker or set the local mirror status to `done`. The reviewer will finalize the status.',
    'AFK will sync the local run result back to the source tracker after reviewer approval; do not attempt to call the source tracker directly.',
    'The local result MUST include a `### Reviewer Notes` subsection that covers: changes made, tests run, caveats or risks, and follow-ups useful to the reviewer.',
    ...(ticket.provider?.runResultInstructions?.length ? ['', ...ticket.provider.runResultInstructions] : []),
  ];
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
    ...(snapshot.mirrorPath ? [`- Linear mirror path: ${snapshot.mirrorPath}`] : []),
    '- Read or update scratch artifacts only at these absolute paths. Do not guess `.scratch` paths relative to the worktree.',
    '',
    ...(dependencyLines.length ? ['## Dependencies', ''] : []),
    ...dependencyLines,
  ];
}
