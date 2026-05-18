# AFK Workflow

## Overview

AFK is implemented as one coordinated local workflow:

1. Discover eligible tickets from `.scratch/*/issues/*.md`
2. Select a model and one or more tickets
3. Prepare deterministic worktree and branch state in TypeScript
4. Launch one run per selected ticket
5. Persist logs and runtime metadata
6. Summarize or clean up work later through read-only or confirmation-gated commands

## Ticket Discovery

Ticket discovery is implemented by `TicketRepository` in `src/ticket-repository.ts`.

Behavior:

- scans `.scratch/<feature>/issues/*.md`
- prefers YAML frontmatter for machine-readable fields
- falls back to legacy `Status:` and `## Status` parsing
- excludes terminal tickets from relaunch

Terminal statuses currently include:

- `done`
- `closed`
- `complete`
- `resolved`
- `ready-for-human`

Tickets are treated as AFK-eligible when they are explicitly AFK-owned or marked `ready-for-agent`.

## Launch Planning

The launch flow currently lives in `src/cli.ts` with support modules:

- `ModelSelector`
- `SelectionService`
- `buildLaunchPlan`

The produced launch plan contains:

- selected model
- selected tickets
- repository root
- recent git context
- prepared checkout context

## Checkout Preparation

Deterministic checkout preparation is implemented in `src/worktree-preparation-service.ts`.

Current rules:

- worktree naming defaults to the feature slug
- branch naming defaults to `afk/<feature-slug>`
- `afk_worktree` and `afk_branch` overrides are supported
- worktrees are created or reused before execution
- branches are local-only and use `git branch --no-track`

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

- preserves selected order within each feature queue
- allows only one active ticket per feature
- caps cross-feature concurrency at `3`
- keeps unrelated queues moving when one ticket fails or is interrupted

## Completion Gate

Terminal completion promotion is guarded by `SummaryPresenceGate`.

Current rule:

- the runner may only promote a ticket to a terminal completed state when the ticket contains a real `## AFK Summary` block

The runner does not fabricate summary content. Agents remain responsible for writing the handoff summary.
