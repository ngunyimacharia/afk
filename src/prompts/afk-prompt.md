# AFK Prompt Instructions

Implement the provided ticket autonomously. Do not ask questions or wait for approval.

## Rules

1. Use the prepared worktree path from Runtime Context. Do not create, switch, push, delete, prune, reset, or clean AFK branches/worktrees.
2. Implement the ticket completely. Add or update code, tests, and docs only as needed for the ticket.
3. Do not create fixup commits, repair disabled tests, or retry known readiness failures unless the ticket or reviewer explicitly requires it.
4. Run relevant verification. If relevant verification fails, fix it or record the blocker.
5. Before handing off to reviewer, ensure relevant static checks pass and record concise evidence in `## AFK Summary`.
6. Stop once the ticket is satisfied. Do not continue working after the code diff meets requirements, listed verification passes, the ticket file is updated, the AFK Summary is written, and changes are committed.
7. If the assigned worktree disappears or becomes invalid, stop and record the blocker. Do not continue execution in the repo root or any other directory.

## Tests

1. Write the **minimum** set of tests required to prove the ticket works and to guard against regressions it introduces. Prefer updating existing tests over creating new files.
2. One focused test per behavior is enough. Do not write multiple tests that assert the same code path with trivially different inputs.
3. If the codebase already has tests covering a seam you modified, update those existing tests rather than duplicating coverage in a new file.
4. Before creating a new test file, verify whether an existing test file in the same domain already covers the subject. If so, add the case there.
5. Do not write tests for framework internals (routing, middleware, queues, validation) unless the ticket specifically changes framework wiring behavior.
6. Run only the tests directly affected by your changes plus the ticket's verification command. Do not run the entire suite unless the ticket explicitly requires it.
7. If the current branch or the test files you are working on contain redundant, unnecessary, or obsolete tests that no longer add value, remove them as part of your changes.

## Verification Budget

1. Run the verification commands listed in the ticket.
2. After final changes are committed and verification passes once, do not rerun the same passing tests again.
3. Record verification evidence in the `## AFK Summary` section.
4. If verification fails on the first attempt, fix the issue and rerun only the failing verification. Do not rerun already-passing verification suites.

## Scratch Artifact Completion Checklist

Before exiting, confirm ALL of the following:
- [ ] The ticket YAML frontmatter `status` field is updated to `done` (or `ready-for-human` if blocked).
- [ ] The ticket file contains an `## AFK Summary` section with a `### Reviewer Notes` subsection.
- [ ] The `### Reviewer Notes` subsection covers: changes made, tests run, caveats or risks, and follow-ups useful to the reviewer.
- [ ] Any scratch artifacts created are local-only under `.scratch/` and are NOT committed to the repo.
- [ ] Source code changes are committed using conventional commits.
- [ ] The PRD or feature spec is updated only if the ticket explicitly requires it.

## Commit and Summary Rules

1. Commit ticket-owned changes using conventional commits. Never commit `.scratch/` and never attribute AI or opencode in commit messages.
2. Update the ticket YAML frontmatter `status` field to `done` when complete, or `ready-for-human` only when human input or implementation is required.
3. Append or update `## AFK Summary` with timestamp, session/run ID, status, outcome, commits, changed areas, verification, blockers/errors, and next action.
4. Do not read or edit `.scratch/` except the provided ticket file and scheduler-generated status files explicitly named by the launcher.
5. Do not run broad process cleanup or delete external temp/system paths. Only stop explicit processes you created for this ticket.
