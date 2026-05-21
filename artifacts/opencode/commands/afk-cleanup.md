---
description: Run `afk cleanup` — clean completed AFK scratch tickets and related logs immediately
---

Run `afk cleanup`. Automatic cleanup of completed AFK work. This command deletes terminal-status issue files, matching AFK logs, runtime metadata, sentinels, and workspace execution state while preserving all pending work.

## Steps

1. **Run dry-run first**: Execute `afk cleanup --dry-run` and parse its output to identify candidate terminal tickets, matching AFK artifacts, and feature-directory deletion intent.

2. **Verify ticket statuses before deletion**: Confirm candidate ticket statuses are terminal (`done`, `closed`, `complete`, `resolved`) and classify non-terminal or missing-status tickets for preservation.

3. **Build a cleanup plan**: For each verified terminal ticket:
   - Record the issue file path for deletion
    - Find matching AFK artifacts under `.scratch/.opencode-afk-logs/` (log, runtime metadata, and sentinels by feature slug and issue name)
    - Record those artifact paths for deletion
    - Record `.scratch/execution.json` for deletion when present
   - Check if the feature directory contains any remaining non-terminal issues; if so, do NOT mark the feature directory for deletion

4. **Display the plan**: Show a clear list of:
   - Issue files that would be deleted
   - Log files that would be deleted
   - Feature directories that would be deleted (only when empty of pending work)
   - Files and directories that will be preserved

5. **Confirm before execution**: Use the `question` tool to ask the user whether to proceed with cleanup after showing the dry-run plan.
   - If the user does not confirm, stop without deleting anything
   - Only continue when the user explicitly confirms

6. **Execute cleanup command**: Run `afk cleanup` to perform deletion according to the reviewed plan:
     - Delete terminal issue files
     - Delete matching AFK log, runtime metadata, and sentinel files
     - Delete `.scratch/execution.json` when present
     - Delete feature directories only when no pending, missing-status, or non-terminal issue files remain
      - Preserve all pending tickets and their logs
      - Do not kill AFK processes as part of log/ticket cleanup

7. **Fallback behavior**: If `afk cleanup --dry-run` output is unavailable, errors, or empty, fall back to direct issue-file scanning of `.scratch/*/issues/*.md` and apply the same terminal/non-terminal safety rules.

## Constraints

- Terminal statuses are: `done`, `closed`, `complete`, `resolved`
- Non-terminal statuses include: `ready-for-agent`, `needs-info`, `needs-triage`, `in-progress`, or any other non-terminal value
- A ticket with no frontmatter status field is treated as non-terminal and must be preserved
- Never delete a feature directory that still contains pending or non-terminal issue files
- Never delete logs, runtime metadata, or sentinels for pending or non-terminal tickets
- Always show a cleanup plan before deletion
- Always ask for explicit user confirmation with the `question` tool after dry-run and before running actual cleanup
- If confirmation is not provided, do not run `afk cleanup`
- Never run broad process cleanup such as `pkill -f opencode-afk`, `pkill -f afk`, or similar commands. They can terminate live AFK sessions because helper paths and prompts contain those strings.
