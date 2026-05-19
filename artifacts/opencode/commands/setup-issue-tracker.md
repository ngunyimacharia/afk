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

Use only the local markdown issue tracker under `.scratch/`.

Interview the user one question at a time only for information that cannot be inferred from the repository:

1. Local markdown structure: use the upstream `.scratch/<feature-slug>/` convention unless the user explicitly needs a different local structure.
2. Triage label vocabulary: inspect existing project labels, status strings, issue docs, and agent docs. Map the five canonical roles to actual project labels or status strings when clear; otherwise use these canonical tags directly without asking for permission:
   - `needs-triage`
   - `needs-info`
   - `ready-for-agent`
   - `ready-for-human`
   - `wontfix`

Use these detailed conventions when drafting the output files. Generate conventions where issues and PRDs live as markdown files under `.scratch/`, one feature per directory, implementation issues live under `.scratch/<feature-slug>/issues/`, and comments append under `## Comments`.

For AFK-compatible local markdown trackers under `.scratch/`, include execution-order conventions:

- issue frontmatter may include `Depends-On` with same-feature issue basenames only, without paths or `.md`
- PRD frontmatter may include `Depends-On-Features` with exact feature directory slugs
- `.scratch/<feature-slug>/execution.json` and `.scratch/execution.json` are derived CLI-managed scheduler files, not hand-authored issue content
- same-wave issues and independent features may run in parallel subject to global concurrency
- first-pass stacked branch automation is linear; fan-in branch handling is deferred/manual unless a project explicitly supports it

Once the `.scratch/` structure and triage vocabulary are determined, write the issue tracker and triage label files immediately. Do not draft them in chat first, do not ask for confirmation before writing files, and do not ask for confirmation before using or documenting the selected tags. After writing, summarize the files changed and the conventions selected.
