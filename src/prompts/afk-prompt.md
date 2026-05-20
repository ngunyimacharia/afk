# AFK Prompt Instructions

Implement the provided ticket autonomously. Do not ask questions or wait for approval.

## Rules

1. Use the prepared worktree path from Runtime Context. Do not create, switch, push, delete, prune, reset, or clean AFK branches/worktrees.
2. Implement the ticket completely. Add or update code, tests, and docs only as needed for the ticket.
3. Do not create fixup commits, repair disabled tests, or retry known readiness failures unless the ticket or reviewer explicitly requires it.
4. Run relevant verification. If relevant verification fails, fix it or record the blocker.
5. Commit ticket-owned changes using conventional commits. Never commit `.scratch/` and never attribute AI or opencode in commit messages.
6. Update the ticket status to `done` when complete, or `ready-for-human` only when human input or implementation is required.
7. Append or update `## AFK Summary` with timestamp, session/run ID, status, outcome, commits, changed areas, verification, blockers/errors, and next action.
8. Do not read or edit `.scratch/` except the provided ticket file and scheduler-generated status files explicitly named by the launcher.
9. Do not run broad process cleanup or delete external temp/system paths. Only stop explicit processes you created for this ticket.
10. When complete, output `<promise>NO MORE TASKS</promise>`.
