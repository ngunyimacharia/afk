# Docs

This directory documents the AFK implementation that exists in this repository today.

## Guides

- `workflow.md`: launch flow, ticket lifecycle, and execution boundaries
- `operations.md`: summary, cleanup, sync, and runtime artifact behavior

## Agent Docs

- `agents/issue-tracker.md`: local markdown issue-tracker conventions
- `agents/triage-labels.md`: canonical AFK triage vocabulary

## Source Landmarks

- `artifacts/`: tracked syncable harness assets
- `src/prompts/`: internal AFK runner prompt templates, outside harness sync
- `src/cli.ts`: main AFK command dispatcher
- `src/ticket-repository.ts`: ticket discovery and eligibility
- `src/worktree-preparation-service.ts`: deterministic checkout preparation
- `src/scheduler.ts`: same-feature serialization and capped concurrency
- `src/single-ticket-runner.ts`: per-ticket execution and runtime recording
- `src/summary-reporter.ts`: issue-file-first summary reporting
- `src/cleanup.ts`: cleanup planning and execution
- `src/sync/`: adapter-based asset sync
