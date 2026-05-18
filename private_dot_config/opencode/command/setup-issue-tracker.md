---
description: Set up issue-tracker context and triage label conventions for agent workflows
---

Inspect the repo to determine whether this is a Laravel Boost project. Detection signals (in order of strength):

- `composer.json` requires `laravel/boost` (strong)
- `boost.json` exists (strong)
- `.ai/guidelines/` directory exists (weak)

If a strong signal is found, ask the user: "Detected Laravel Boost. Use Boost conventions?"
If only the weak signal is found, ask: "Found `.ai/guidelines/` directory. Is this a Laravel Boost project?"
If the user confirms the Boost branch:

- If `composer.json` requires `laravel/boost` but `boost.json` or `.ai/guidelines/` is missing, run `php artisan boost:install`.
- If `boost.json` exists, run `php artisan boost:update`.
- Then proceed with Boost file writing.

If the user declines or no signal is found, proceed to the upstream-lite branch.

Interview the user one question at a time:

1. Issue tracker: GitHub, Jira, or local markdown?
2. Tracker-specific configuration:
   - GitHub: infer from `git remote -v` or ask for `owner/repo`.
   - Jira: ask for the Jira site URL, project key (for example `PROJ`), and default issue type.
   - Local markdown: use the upstream `.scratch/<feature-slug>/` convention unless the user explicitly needs a different structure.
3. Triage label vocabulary: map the five canonical roles to actual project labels or status strings:
   - `needs-triage`
   - `needs-info`
   - `ready-for-agent`
   - `ready-for-human`
   - `wontfix`

Use these detailed conventions when drafting the output files. For local markdown issue tracker output, generate conventions where issues and PRDs live as markdown files under `.scratch/`, one feature per directory, implementation issues live under `.scratch/<feature-slug>/issues/`, and comments append under `## Comments`.

Draft the issue tracker and triage label files in chat but DO NOT write them yet. Show a diff of the proposed changes against the current file state. Ask "Write these files?" and only proceed if the user explicitly confirms.
