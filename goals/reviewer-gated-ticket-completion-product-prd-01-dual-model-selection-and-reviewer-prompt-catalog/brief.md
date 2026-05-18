# Dual Model Selection and Reviewer Prompt Catalog

## Outcome

Add dual-model selection and a reviewer prompt catalog for reviewer-gated ticket completion.

## Context

- AFK is a local TypeScript runner for markdown tickets in `.scratch/`.
- The current launch flow already selects one model and one or more tickets.
- This goal extends that flow so a run can also choose a reviewer model and a reviewer prompt from a maintained catalog.
- Relevant project surfaces include `src/cli.ts`, `src/model-selector.ts`, `src/selection-service.ts`, `src/prompts/`, `tests/`, and `docs/workflow.md`.
- AFK is intentionally local-first: keep worktree/branch preparation deterministic and do not introduce network-dependent prompt fetching.

## Constraints

- Keep the existing single-model launch path working for tickets that do not need reviewer gating.
- Preserve AFK's local-only worktree and branch behavior.
- Keep ticket discovery and terminal-status filtering unchanged.
- Store prompt catalog content in repo files so it is reviewable and versioned.
- Verification must be reproducible with local commands and inspected artifacts.

## Non-Goals

- Rebuilding the issue tracker format or moving away from markdown tickets.
- Adding hosted services, remote prompt sync, or model-provider abstractions beyond the launcher needs.
- Redesigning cleanup, summary, or ticket triage behavior unrelated to model or prompt selection.

## Ask Before

- Changing the existing default model behavior.
- Removing the single-model path.
- Any destructive git, worktree, or tracker changes beyond normal feature work.
- Any prompt catalog schema change that would invalidate already-authored catalog entries.

## Done Means

- The AFK launch flow can collect both a primary model and a reviewer model.
- A reviewer prompt can be chosen from a repo-backed catalog and carried through the run plan.
- Automated tests cover the selection and catalog behavior.
- The reviewed implementation is documented and its evidence is recorded in `progress.jsonl`.
