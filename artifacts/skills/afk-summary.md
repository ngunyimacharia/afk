---
name: afk-summary
description: Run `afk summary` — read-only summary of AFK work from tickets and logs
---

Run `afk summary`. Read-only summary of AFK work. This command is strictly read-only and strictly informational. It must never clean up, delete, edit, stage, commit, or change anything.

## Steps

1. **Run the CLI command first**: Execute `afk summary` and parse the command output as the primary source.

2. **Parse the standard sections**: Extract entries from:
   - `Completed or successful work`
   - `Handoff or manual review`
   - `Failed or blocked work`
   - `Interrupted or incomplete work`
   - `Not yet started`
   - `Won't fix`
   - `Legacy / malformed`
   - `Missing summaries`
   - `Repeated attempts`
   - Optional diagnostics: `Phase timing highlights`, `Failure kind totals`

3. **Report every recorded attempt**: Preserve all listed attempts, including repeated attempts on the same issue.

4. **Group the report by outcome**:
   - Completed or successful work
   - Handoff or manual review
   - Failed or blocked work
   - Interrupted or incomplete work
   - Not yet started — tickets with pre-work statuses (`ready-for-agent`, `ready-for-human`, `needs-triage`, `needs-info`) that have no AFK Summary
   - Won't fix — tickets with `wontfix` status that have no AFK Summary
   - Legacy / malformed — tickets with no status field that have no AFK Summary
   - Missing summaries — tickets that were attempted but lack an AFK Summary block
   - Repeated attempts

5. **Use issue files only as fallback**: If `afk summary` is unavailable, errors, or returns empty output, inspect `.scratch/*/issues/*.md`, read frontmatter `status`, and parse each `## AFK Summary` block.

6. **Gate raw log reads behind permission**: Never inspect `.scratch/.opencode-afk-logs/` unless the user grants permission for this invocation. Ask every time before reading raw logs, even if a prior run already allowed it.

7. **Do not ask for cleanup or delegate cleanup**: Never ask the user for confirmation from this summary command, and never hand off to any cleanup command or flow.

8. **Only ask for raw logs for these reasons**:
    - Missing summaries
    - Legacy / malformed
    - Incomplete details
    - Contradictory summaries
    - Explicit user request for deeper investigation

9. **Make the permission request specific**: State the intended log scope and the reason before any raw log access. Example scope: a named issue, a time window, or a specific subset of `.scratch/.opencode-afk-logs/`.

10. **Fallback when permission is absent or denied**: Continue with CLI-output and/or issue-file-only output and explicitly note that raw logs were not inspected.

11. **Produce summary**: Output a structured report containing:
    - Completed work: ticket references, status, and AFK summary details
    - Handoff or manual review: ticket references, status, and handoff details
    - Failed or blocked work: ticket references, status, and blocker details
    - Interrupted or incomplete work: ticket references, status, and last known state
    - Not yet started: tickets with pre-work statuses that have no AFK Summary
    - Won't fix: tickets with `wontfix` status that have no AFK Summary
    - Legacy / malformed: tickets with no status field that have no AFK Summary
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
