Status: done

# Move worktree and branch preparation into TypeScript orchestration

## Why

The core v1 safety change is to stop relying on prompt compliance for deterministic checkout setup. This slice makes worktree and branch preparation testable, repeatable, and owned by TypeScript before any agent session starts.

## Scope

Includes:
- implement `WorktreePreparationService` for default/effective worktree and branch derivation
- support `afk_worktree` and `afk_branch` ticket overrides while treating `afk_worktree` as a name, not a path
- create or reuse persistent local worktrees and local-only AFK branches before execution starts
- enforce no push, no upstream tracking, and no prune/reset/clean/remove behavior during normal preparation
- pass prepared checkout context into prompt construction so prompts describe prepared state instead of owning it

Excludes:
- launching agent sessions
- copying logs or runtime metadata
- cleanup of worktrees or branches

## Context

- Parent PRD/spec: `.scratch/afk-v1-workflow/PRD.md`
- Relevant design/tech notes: `PRDs/prompts/afk-prompt.md`, `PRDs/afk-opencode-sdk-session-runner-orchestration-prd.md`

## Dependencies

Blocking:
- `.scratch/afk-v1-workflow/issues/01-ticket-discovery-and-launch-selection.md`

Related:
- none

## Acceptance Criteria

1. For each selected ticket, orchestration derives feature slug, default worktree name, effective worktree name, default branch name, and effective branch name from ticket metadata.
2. TypeScript creates or reuses the persistent local worktree and the local-only AFK branch before provider execution begins.
3. Preparation never pushes branches, configures upstream tracking, deletes worktrees, removes branches, prunes worktrees, resets state, or runs git clean.
4. Prompt construction consumes prepared checkout details as input and no longer treats agent-side worktree setup as the primary deterministic mechanism.
5. Preparation fails clearly when git rejects the requested worktree or branch state.

## Verification

- Automated code tests: add `worktree-preparation-service.test.ts` for name derivation, override handling, create-vs-reuse behavior, and safety guards; add `prompt-builder.test.ts` regression coverage proving prepared checkout context is injected and prompt text no longer owns deterministic worktree setup.
- Add an integration-style test fixture that exercises preparation against a temporary git repository and verifies the expected worktree and local branch are created or reused.
- Manual check: run `afk` against a fixture ticket twice and confirm the second run reuses the same worktree/branch without destructive git commands.

## Classification

- Executor: `AFK`
- Rationale: the desired git behavior and prompt-contract change are explicit in the PRD and testable locally.

## Comments

## AFK Summary

### 2026-05-18

- Timestamp: 2026-05-18
- Session/run ID: local-afk
- Issue reference: 02-typescript-worktree-and-branch-preparation
- Tracker status: done
- Outcome: implemented TypeScript checkout preparation and prompt context plumbing
- Commits: pending
- Notable changes: added worktree preparation service, prompt builder, and checkout context propagation
- Files/areas touched: src/cli.ts, src/launch-context-builder.ts, src/types.ts, src/prompt-builder.ts, src/worktree-preparation-service.ts, tests/*
- Tests/checks run: `npm test`
- Blockers/errors: integration worktree reuse behavior still needs a stronger fixture if the repo layout changes
- Next action: commit the code changes
