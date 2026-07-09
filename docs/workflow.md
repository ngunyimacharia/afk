# AFK Workflow

## Overview

AFK is implemented as one coordinated local workflow:

1. Discover eligible tickets from `.scratch/*/issues/*.md`
2. Select a harness, model, reviewer model, and one or more feature directories
3. Prepare deterministic worktree and branch state in TypeScript
4. Launch one run per selected ticket
5. Persist logs and runtime metadata
6. Summarize or clean up work later through read-only or confirmation-gated commands

## Ticket Discovery

Ticket discovery is implemented by `TicketRepository` in `src/ticket-repository.ts`.

Behavior:

- scans `.scratch/<feature>/issues/*.md`
- requires opening YAML frontmatter for machine-readable fields
- rejects legacy `Status:` and `## Status` scheduling metadata
- excludes terminal tickets from relaunch
- parses same-feature `Depends-On` issue frontmatter

Terminal statuses currently include:

- `done`
- `closed`
- `complete`
- `resolved`
- `ready-for-human`

Tickets are treated as AFK-eligible when they are explicitly AFK-owned or marked `ready-for-agent`.

## Dependency State

AFK derives execution state instead of treating `.scratch` markdown as mutable scheduler state:

- `.scratch/<feature>/execution.json` contains per-feature issue graph state, topological waves, ticket states, and blocking reasons.
- `.scratch/execution.json` contains the selected workspace feature graph, feature waves, concurrency, blocked feature reasons, and stack parent metadata.
- Both files are CLI-managed and can be regenerated from ticket/PRD markdown.
- Issue dependencies use `Depends-On` in issue frontmatter.
- Feature dependencies use `Depends-On-Features` in PRD frontmatter.

## Launch Planning

The launch flow currently lives in `src/cli.ts` with support modules:

- `ModelSelector`
- `SelectionService`
- `buildLaunchPlan`

The produced launch plan contains:

- selected harness
- selected model
- selected tickets
- repository root
- recent git context
- prepared checkout context

Codex is selectable when its discovery path returns at least `codex/default`. Set `AFK_CODEX_MODELS` to a comma-separated list of explicit model names when operators should choose a concrete Codex model instead of the configured Codex default.

PI is selectable when its discovery path returns at least `pi/default`. Set `AFK_PI_MODELS` to a comma-separated list of explicit PI model names (in `provider/model` form when possible) when operators should choose a concrete PI model. PI uses the host configuration under `~/.pi/agent` and receives the prepared worktree path plus a phase-appropriate tool allowlist.

## Checkout Preparation

Deterministic checkout preparation is implemented in `src/worktree-preparation-service.ts`.

Current rules:

- worktree naming defaults to the feature slug
- branch naming defaults to the feature slug
- `afk_worktree` and `afk_branch` overrides are supported
- worktrees are created or reused before execution
- branches are local-only and use `git branch --no-track`
- Codex and PI runs receive the prepared worktree path as their `workingDirectory`

Normal preparation does not:

- push branches
- configure upstream tracking
- delete worktrees
- remove branches
- reset state
- run `git clean`

## Scheduling and Execution

Execution is split between:

- `SingleTicketRunner` for one ticket
- `Scheduler` for multi-ticket coordination

Current scheduler behavior:

- schedules ready tickets by dependency state
- allows same-feature tickets to run in parallel when no dependency relationship blocks them
- caps global ticket concurrency at the selected value, defaulting to `3`
- keeps unrelated queues moving when one ticket fails or is interrupted
- auto-advances later issue or feature waves as dependencies complete

First-pass feature stacks are linear. A dependent feature branch is created from `afk/<upstream-feature>` once the upstream AFK tickets are complete; multiple feature parents fail automatic branch preparation with a clear fan-in deferred message.

## Feature Completion Handling

After all selected tickets for a feature complete successfully, AFK creates a GitHub pull request for that feature branch. This applies to both inline and background daemon runs.

Supported action:

- `create-pr` pushes the feature branch and opens a GitHub pull request into the base branch via a dedicated pull-request agent mode (push and PR permissions only, no source edits). The repository's PR template is used when one is discovered.

PR creation is now the only feature completion option. The former `merge-to-base` action has been removed.

Behavior notes:

- Only features whose every selected ticket completed successfully are eligible.
- A PR creation failure for one feature does not stop PR attempts for other completed features.
- Created PR URLs (or per-feature failure reasons) appear in run progress and the final run output.
- After a successful PR, AFK best-effort removes the local feature worktree and branch only when cleanup is proven safe and the remote branch exists. AFK never deletes the remote branch.


## Completion Gate

Terminal completion promotion is guarded by `SummaryPresenceGate`.

Current rule:

- the runner may only promote a ticket to a terminal completed state when the ticket contains a real `## AFK Summary` block

The runner does not fabricate summary content. Agents remain responsible for writing the handoff summary.
