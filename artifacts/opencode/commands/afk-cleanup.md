---
description: Clean completed AFK scratch tickets and related logs immediately
---

Automatic cleanup of completed AFK work. This command deletes terminal-status issue files, matching AFK logs, runtime metadata, sentinels, and workspace execution state while preserving all pending work.

## Steps

1. **Scan for terminal tickets**: Inspect `.scratch/*/issues/*.md` for all local markdown tickets. Identify tickets with terminal statuses: `done`, `closed`, `complete`, or `resolved`.

2. **Scan for pending tickets**: Identify all tickets with non-terminal statuses (e.g., `ready-for-agent`, `needs-info`, `needs-triage`, `in-progress`) or missing status lines. These must be preserved.

3. **Build a cleanup plan**: For each terminal ticket:
   - Record the issue file path for deletion
    - Find matching AFK artifacts under `.scratch/.opencode-afk-logs/` (log, runtime metadata, and sentinels by feature slug and issue name)
    - Record those artifact paths for deletion
    - Record `.scratch/execution.json` for deletion when present
   - Check if the feature directory contains any remaining non-terminal issues; if so, do NOT mark the feature directory for deletion

4. **Display the plan**: Show the user a clear list of:
   - Issue files that would be deleted
   - Log files that would be deleted
   - Feature directories that would be deleted (only when empty of pending work)
   - Files and directories that will be preserved

5. **Execute deletion**:
    - Delete terminal issue files
    - Delete matching AFK log, runtime metadata, and sentinel files
    - Delete `.scratch/execution.json` when present
    - Delete feature directories only when no pending, missing-status, or non-terminal issue files remain
    - Preserve all pending tickets and their logs
    - Do not kill AFK processes as part of log/ticket cleanup

## Constraints

- Terminal statuses are: `done`, `closed`, `complete`, `resolved`
- Non-terminal statuses include: `ready-for-agent`, `needs-info`, `needs-triage`, `in-progress`, or any other non-terminal value
- A ticket with no status line is treated as non-terminal and must be preserved
- Never delete a feature directory that still contains pending or non-terminal issue files
- Never delete logs, runtime metadata, or sentinels for pending or non-terminal tickets
- Always show a cleanup plan before deletion
- Never run broad process cleanup such as `pkill -f opencode-afk`, `pkill -f afk`, or similar commands. They can terminate live AFK sessions because helper paths and prompts contain those strings.
