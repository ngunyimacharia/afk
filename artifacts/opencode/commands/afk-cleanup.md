---
description: Clean completed AFK scratch tickets and related logs with confirmation gating
---

Safe, confirmation-gated cleanup of completed AFK work. This command deletes terminal-status issue files and their matching AFK logs while preserving all pending work.

## Steps

1. **Scan for terminal tickets**: Inspect `.scratch/*/issues/*.md` for all local markdown tickets. Identify tickets with terminal statuses: `done`, `closed`, `complete`, or `resolved`.

2. **Scan for pending tickets**: Identify all tickets with non-terminal statuses (e.g., `ready-for-agent`, `needs-info`, `needs-triage`, `in-progress`) or missing status lines. These must be preserved.

3. **Build a cleanup plan**: For each terminal ticket:
   - Record the issue file path for deletion
   - Find the matching AFK log under `.scratch/.opencode-afk-logs/` (by feature slug and issue name)
   - Record the log file path for deletion
   - Check if the feature directory contains any remaining non-terminal issues; if so, do NOT mark the feature directory for deletion

4. **Display the plan**: Show the user a clear list of:
   - Issue files that would be deleted
   - Log files that would be deleted
   - Feature directories that would be deleted (only when empty of pending work)
   - Files and directories that will be preserved

5. **Require confirmation**: Ask the user to confirm before proceeding with deletion. Do not delete anything without explicit confirmation, unless the invocation message already includes explicit confirmation (e.g., "yes, proceed" or "--force").

6. **Execute deletion** (only after confirmation):
    - Delete terminal issue files
    - Delete matching AFK log files
    - Delete feature directories only when no pending, missing-status, or non-terminal issue files remain
    - Preserve all pending tickets and their logs
    - Do not kill AFK processes as part of log/ticket cleanup

## Constraints

- Terminal statuses are: `done`, `closed`, `complete`, `resolved`
- Non-terminal statuses include: `ready-for-agent`, `needs-info`, `needs-triage`, `in-progress`, or any other non-terminal value
- A ticket with no status line is treated as non-terminal and must be preserved
- Never delete a feature directory that still contains pending or non-terminal issue files
- Never delete logs for pending or non-terminal tickets
- Always show a dry-run plan before any deletion
- Require explicit confirmation before executing destructive operations
- Never run broad process cleanup such as `pkill -f opencode-afk`, `pkill -f afk`, or similar commands. They can terminate live AFK sessions because helper paths and prompts contain those strings.
