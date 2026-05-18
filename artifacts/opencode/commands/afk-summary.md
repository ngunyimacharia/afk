---
description: Summarize completed, failed, and interrupted AFK work from tickets and logs
---

Read-only summary of AFK work. This command is strictly read-only and strictly informational. It must never clean up, delete, edit, stage, commit, or change anything.

## Steps

1. **Collect issue files first**: Inspect `.scratch/*/issues/*.md` as the default source of truth for AFK work.

2. **Read issue metadata**: For each issue file, read the `Status:` line near the top and every `## AFK Summary` block in the file.

3. **Report every recorded attempt**: Treat each `## AFK Summary` block as one AFK attempt. Include repeated attempts on the same issue, even when they reference the same ticket or outcome.

4. **Group the report by outcome**:
   - Completed or successful work
   - Failed or blocked work
   - Interrupted or incomplete work
   - Issues with missing `## AFK Summary` blocks

5. **Handle missing summaries explicitly**: If an issue file has no `## AFK Summary` block, report it as missing a summary. Do not fall back to raw AFK logs on the default path.

6. **Gate raw log reads behind permission**: Never inspect `.scratch/.opencode-afk-logs/` unless the user grants permission for this invocation. Ask every time before reading raw logs, even if a prior run already allowed it.

7. **Do not ask for cleanup or delegate cleanup**: Never ask the user for confirmation from this summary command, and never hand off to any cleanup command or flow.

8. **Only ask for raw logs for these reasons**:
    - Missing summaries
    - Incomplete details
    - Contradictory summaries
    - Explicit user request for deeper investigation

9. **Make the permission request specific**: State the intended log scope and the reason before any raw log access. Example scope: a named issue, a time window, or a specific subset of `.scratch/.opencode-afk-logs/`.

10. **Fallback when permission is absent or denied**: Continue with issue-file-only output and explicitly note that raw logs were not inspected.

11. **Produce summary**: Output a structured report containing:
    - Completed work: ticket references, status, and AFK summary details
    - Failed or blocked work: ticket references, status, and blocker details
    - Interrupted or incomplete work: ticket references, status, and last known state
    - Missing summaries: issue references with no `## AFK Summary` block
    - Any repeated attempts or patterns visible across issue summaries

## Constraints

- Read-only: do not edit, delete, move, or create any files
- Do not change ticket statuses
- Do not commit or stage any changes
- Do not clean up tmux resources or delete opencode sessions
- Do not run broad process cleanup or terminate AFK helper processes
- Do not scan `.scratch/.opencode-afk-logs/` on the default path
- Do not scan `.scratch/.opencode-afk-logs/` unless permission was granted for the current invocation
- Report only; take no action beyond reading and summarizing
