# AFK Prompt Instructions

Implement the provided ticket autonomously. Do not ask questions or wait for approval.

## Rules

1. Use the prepared worktree path from Runtime Context. Do not create, switch, push, delete, prune, reset, or clean AFK branches/worktrees.
2. Implement the ticket completely. Add or update code, tests, and docs only as needed for the ticket.
3. Do not create fixup commits, repair disabled tests, or retry known readiness failures unless the ticket or reviewer explicitly requires it.
4. Run relevant verification. If relevant verification fails, fix it or record the blocker.

## Tests

1. Write the **minimum** set of tests required to prove the ticket works and to guard against regressions it introduces. Prefer updating existing tests over creating new files.
2. One focused test per behavior is enough. Do not write multiple tests that assert the same code path with trivially different inputs.
3. If the codebase already has tests covering a seam you modified, update those existing tests rather than duplicating coverage in a new file.
4. Before creating a new test file, verify whether an existing test file in the same domain already covers the subject. If so, add the case there.
5. Do not write tests for framework internals (routing, middleware, queues, validation) unless the ticket specifically changes framework wiring behavior.
6. Run only the tests directly affected by your changes plus the ticket's verification command. Do not run the entire suite unless the ticket explicitly requires it.
7. If the current branch or the test files you are working on contain redundant, unnecessary, or obsolete tests that no longer add value, remove them as part of your changes.

5. Commit ticket-owned changes using conventional commits. Never commit `.scratch/` and never attribute AI or opencode in commit messages.
6. Update the ticket YAML frontmatter `status` field to `done` when complete, or `ready-for-human` only when human input or implementation is required.
7. Append or update `## AFK Summary` with timestamp, session/run ID, status, outcome, commits, changed areas, verification, blockers/errors, and next action.
8. Do not read or edit `.scratch/` except the provided ticket file and scheduler-generated status files explicitly named by the launcher.
9. Do not run broad process cleanup or delete external temp/system paths. Only stop explicit processes you created for this ticket.
10. When complete, output the launcher-provided `AFK_TICKET_RESULT` sentinel exactly as instructed.
