# Plan: Dual Model Selection and Reviewer Prompt Catalog

## Solution Overview

Extend AFK's launch flow so a user can choose two models instead of one: a working model for the ticket implementation and a reviewer model for the gated review step. Add a small, repo-backed reviewer prompt catalog so the reviewer role can be selected from stable, versioned prompt templates instead of ad hoc text. The goal is to make reviewer-gated completion explicit, repeatable, and easy to audit without changing AFK into a new workflow system.

## Why This Approach

AFK already centers its behavior around deterministic local planning, markdown tickets, and explicit launch-time choices. Keeping model and reviewer-prompt selection in the existing CLI flow preserves that mental model and avoids introducing new services or hidden state. A catalog stored in the repo gives the reviewer step a stable review surface, makes changes code-reviewable, and keeps the feature lightweight enough to ship without reworking the scheduler or tracker.

## How It Will Work

The launch wizard will gather a primary model and a reviewer model as separate choices. After that, it will present reviewer prompt templates from a local catalog and carry the selected template into the launch plan and runtime metadata. The ticket runner will continue to execute the implementation work as today, but reviewer-gated completion will have an explicit prompt source and model pairing available to downstream steps. The code changes should remain concentrated in the selection and launch-planning path, with the catalog implemented as ordinary tracked files under `src/prompts/` or a similar repo-backed location.

## Slices

| Slice | Purpose | Main files or systems | Done when | Risks |
| --- | --- | --- | --- | --- |
| 1 | Capture dual-model selection in the launch flow | `src/cli.ts`, `src/model-selector.ts`, `src/selection-service.ts` | The wizard can pick both a working model and a reviewer model, and the launch plan carries both values | Confusing UX or accidental breakage of the existing single-model path |
| 2 | Add a repo-backed reviewer prompt catalog | `src/prompts/`, prompt loading helpers, tests | Prompt templates are discoverable, selectable, and serialized in a stable format | Catalog drift or schema churn |
| 3 | Thread reviewer choices through runtime evidence | launch plan, runtime metadata, summary artifacts, tests | Runs record the chosen reviewer model and reviewer prompt so the handoff is auditable | Missing evidence or mismatched metadata |

## Sequencing

- Slice 1 must land first because later slices depend on the launch plan shape.
- Slice 2 can be done in parallel with the plan plumbing once the data model is agreed.
- Slice 3 depends on both prior slices because it validates that the selected values survive the run.

## Phase Boundaries

- End this goal once the launcher, catalog, and evidence plumbing are complete and verified.
- If work expands into reviewer execution policy, prompt-generation strategy, or multi-step approval orchestration, split that into a new goal.

## Steering Notes

- Prefer minimal UI changes over new abstractions.
- Keep prompt catalog entries small and legible.
- If there is a tradeoff between a broader framework and a targeted launcher change, prefer the targeted change.

## Acceptance Criteria

- [ ] The launch wizard can collect and persist both a primary model and a reviewer model, and the resulting launch plan exposes both values.
- [ ] The reviewer prompt catalog is loaded from tracked repo files, and at least one selectable prompt template is available in the launch flow.
- [ ] The selected reviewer model and reviewer prompt appear in runtime metadata or other inspectable run evidence.
- [ ] Automated tests cover the selection flow, catalog loading, and evidence plumbing.

## Required Evidence

| Requirement | Evidence to inspect | Where evidence is recorded |
| --- | --- | --- |
| Dual model selection | Test output plus the launch-plan shape or log showing both models | `progress.jsonl` and test artifacts |
| Reviewer prompt catalog | Catalog file contents and loader test output | `progress.jsonl` and repo files |
| Runtime evidence | Metadata or summary artifact showing the chosen reviewer prompt | `progress.jsonl` and runtime artifacts |
| Verification | `bun test` and `bun run build` results | `progress.jsonl` |

## Completion Audit

Before marking the goal complete, Codex must map every explicit requirement, file, command, check, and deliverable to real evidence. If any item is missing, incomplete, weakly verified, or uncertain, the goal is not complete.
