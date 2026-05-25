---
name: to-scratch
description: Turn conversation context, a PRD, spec, or plan into a canonical Local Markdown scratch package with a PRD and AFK-ready implementation issues
---

# To Scratch

Turn the current conversation context, an existing PRD, a spec, or an implementation plan into one or more canonical Local Markdown feature packages under `.scratch/`.

The default output is a complete scratch package:

```text
.scratch/
  <feature-slug>/
    PRD.md
    issues/
      01-first-slice.md
      02-second-slice.md
```

The PRD captures the product intent for review and handoff. The issues break that intent into narrow, dependency-ordered, independently verifiable implementation slices for AFK execution.

## Default Behavior

- From raw conversation or repo context, generate both `.scratch/<feature-slug>/PRD.md` and `.scratch/<feature-slug>/issues/<NN>-<slug>.md`.
- From an existing approved PRD, spec, or implementation plan, infer issues-only mode and generate or update the canonical issue set under the matching feature folder.
- Do not use GitHub or any external issue tracker. This command is Local Markdown only.
- Do not run implementation commands or start implementation.
- Do not require a separate approval gate between PRD and issue generation when the context is sufficient.
- Ask at most 1-2 focused questions at a time, and only when missing or conflicting information would materially change the PRD scope, issue structure, dependencies, or execution readiness.

## Operating Rules

- Before drafting, inspect the repo and relevant docs if you have not already.
- Use the project's domain glossary and naming conventions throughout.
- Respect ADRs, design docs, and other architecture guidance in the area you touch.
- Use the Local Markdown conventions in this command as the source of truth for scratch package layout, triage statuses, dependencies, comments, and verification expectations.
- Produce multiple feature packages when the request naturally contains multiple products, user outcomes, deep modules, or independently testable feature slices.
- Choose deterministic, human-readable folder slugs derived from each PRD title or scope.
- Keep PRDs user-facing where possible. Do not drift into a low-level design doc.
- Do not include code snippets unless a short prototype artifact captures a stable decision more precisely than prose can.
- Actively look for deep module opportunities when describing implementation decisions.
- Favor deep modules over shallow ones: a deep module hides meaningful complexity behind a small, stable, testable interface.
- Ensure each PRD and issue set is end-to-end testable through durable external behaviors or stable module interfaces.
- Prefer decomposition by user-visible value and executable seams, not by technical layer.
- Avoid issues like "build backend", "build frontend", or "add tests" as standalone work unless that is genuinely the smallest independently useful slice.

## Local Markdown Layout Requirements

For Local Markdown, publish feature packages in this exact shape because AFK feature selection and execution read these paths:

```text
.scratch/
  <feature-slug>/
    PRD.md
    issues/
      01-first-slice.md
      02-second-slice.md
```

Rules:

- PRD files are always named `PRD.md` with exact uppercase casing.
- Issue files are always placed under `.scratch/<feature-slug>/issues/`.
- Issue files are numbered from `01` and use stable slug basenames.
- Never publish implementation issue files directly under `.scratch/<feature-slug>/`.
- Triage state is recorded as a mandatory `status` field in opening YAML frontmatter.
- Machine-readable ticket metadata must use opening YAML frontmatter. Legacy `Status:` lines are invalid for AFK scheduling.
- Comments and conversation history append under a `## Comments` heading.
- If the repo contains a non-canonical feature folder, such as `.scratch/<feature-slug>/prd.md` or `.scratch/<feature-slug>/01-slice.md`, normalize future output to the canonical layout and report the mismatch.
- Each issue must begin with YAML frontmatter before the title or any other body content. Include `status: ready-for-agent` unless the conversation explicitly requires a different canonical status.
- AFK derives `.scratch/<feature-slug>/execution.json` from issue markdown and `.scratch/execution.json` from selected feature PRDs; do not hand-author these derived files.

## Existing Scratch Packages

When a target `.scratch/<feature-slug>/` already exists:

- Update or create the canonical `.scratch/<feature-slug>/PRD.md` when needed.
- Preserve existing files under `.scratch/<feature-slug>/issues/` unless the user explicitly asks to regenerate them.
- If issues already exist and the PRD changed or may have changed, warn that the existing issues may be stale.
- Create missing issue files only when doing so is safe and does not overwrite or renumber existing user work.
- Report conflicts, stale issue risks, duplicate numbering, non-canonical layouts, and any issue set that no longer appears aligned with the PRD.
- Never delete, overwrite, or renumber existing issue files without explicit user instruction.

## AFK Frontmatter And Dependencies

When a PRD or issue needs a non-default AFK worktree or branch name, include optional frontmatter so downstream execution carries the same context:

```yaml
afk_worktree: custom-name
afk_branch: custom-name
```

- `afk_worktree` is a name, not an absolute path, and maps to repo-local `.worktree/<name>`.
- If these fields are omitted, infer the effective worktree and branch from the feature slug.
- The default branch expectation is `afk/<feature-slug-or-override>`.
- Keep the effective worktree and branch stable for the same feature unless the work is intentionally split into separate feature folders.
- Issues from the same feature folder share one effective feature checkout, but may run in parallel when no `Depends-On` relationship blocks them.
- If a different independent branch is needed, split the work into separate feature folders intentionally.
- When a PRD depends on another feature PRD, include `Depends-On-Features` in PRD frontmatter using exact `.scratch/<feature-slug>` directory slugs.
- Use feature dependencies only for true blockers between feature outcomes, not preferred sequencing.
- Call out whether the dependency is a linear stack or fan-in. First-pass AFK branch automation supports linear stacks only; fan-in or multiple-parent branch preparation is deferred/manual unless a PRD explicitly scopes it.
- Add same-feature issue dependencies to issue YAML frontmatter as `Depends-On` using issue basenames only, without paths or `.md`.
- Use `Depends-On` only for true same-feature issue blockers, not preferred ordering.
- The prose `## Dependencies` section is informational only. Scheduling dependencies are defined exclusively in frontmatter `Depends-On`.

Dependency frontmatter examples:

```md
---
status: ready-for-agent
Depends-On:
  - 01-foundation
  - 02-shared-types
---
```

```md
---
Depends-On-Features:
  - auth-core
---
```

## Triage Status Semantics

Use these canonical Local Markdown status strings unless the conversation explicitly requires a different status:

| Triage role | Status value | Meaning |
| ----------- | ------------ | ------- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate this issue |
| `needs-info` | `needs-info` | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |

## Repo Grounding

During exploration, look for:

- project type, language, framework, and stack
- architectural boundaries and existing module seams
- docs such as `README`, `CONTEXT.md`, `CONTEXT-MAP.md`, ADRs, feature specs, and glossary docs
- existing test patterns and nearby prior art
- agent index docs or planning guidance, if relevant to scratch package structure

## PRD Guidance

Each PRD should include enough context for review and downstream implementation without becoming a line-by-line technical design.

Include:

- the user or system outcome
- background and current behavior
- goals and non-goals
- functional requirements
- UX, API, CLI, data, or operational behavior when relevant
- dependency notes and feature-level blockers
- acceptance criteria or externally observable success conditions
- risks, edge cases, and open questions

Do not include file paths unless the user explicitly asks for them or a path is necessary to explain Local Markdown scratch output.

## Issue Breakdown Guidance

Use tracer-bullet vertical slicing:

- prefer end-to-end slices over horizontal layers
- make each issue small enough to grab and finish
- make each issue independently testable or otherwise verifiable
- include schema, API, UI, and tests in the same issue when that creates a true vertical slice
- support either a human or a coding agent as the executor
- prefer AFK issues when possible
- mark HITL only when a real human checkpoint is required

Optimize for:

1. Vertical slices first
2. Narrow scope
3. Independent verification
4. Minimal blocker dependencies
5. AFK preference

A good slice is the smallest unit that:

- delivers a coherent outcome
- can be verified independently
- does not require reopening the whole PRD to execute
- would reasonably fit in one focused implementation effort or PR

## Definition Of Ready

Do not publish an issue unless all of these are true:

- the issue has a clear outcome
- the scope boundary is understandable
- blocker dependencies are explicit or absent
- acceptance criteria are observable
- verification is concrete
- the issue has enough local context to execute without reopening the whole PRD
- AFK/HITL classification is justified

If these conditions are not met, keep the issue in proposal form and surface the gap.

## Classification Semantics

Classification is operational, not just descriptive.

- `AFK`: this issue can be executed end-to-end without additional human product, design, or architecture decisions beyond normal review
- `HITL`: this issue requires a specific human checkpoint, decision, or approval before completion

Rules:

- Every `HITL` issue must name the exact checkpoint needed.
- Do not mark an issue `HITL` just because it is important, risky, or large.
- If an issue can be split into AFK pre-work plus a smaller HITL decision point, prefer that split.
- Map `AFK` and `HITL` to the repo's configured local status or label conventions when present.

## Automated Code Test Expectations

Every implementation issue must include automated code test expectations in its Verification section:

- Name the automated code tests to add or run.
- If no automated code test is appropriate, explicitly say so and provide fallback verification such as manual steps, demo output, logs, or screenshots.
- Distinguish automated code tests from manual checks or non-code verification.

## Issue Template

Use this structure for each issue:

```md
---
status: ready-for-agent
---

## Title

A concise, outcome-oriented title describing one slice.

## Why

1-3 sentences on the user, system, or business value of this slice.

## Scope

Includes:
- the specific behavior or result delivered by this issue

Excludes:
- closely related work intentionally left out of this slice

## Context

- Parent PRD/spec: <link or reference>
- Relevant design/tech notes: <links only, brief note if essential>

## Dependencies

- Frontmatter `Depends-On`: <issue refs only if true blockers>

Related:
- <optional non-blocking references>

## Acceptance Criteria

1. <observable condition of done>
2. <observable condition of done>
3. <edge case or failure-mode condition if materially relevant>

## Verification

- Automated code tests: <name the automated code tests to add or run, or explicitly state why no automated code test is appropriate and provide fallback verification>
- <demo, repro steps, or operational checks if applicable>
- <what evidence is expected: passing test, screenshot, logs, PR link>

## Classification

- Executor: `AFK` or `HITL`
- Rationale: <one sentence>
- If HITL: <exact human input, decision, or approval required>
```

## Process

1. Explore the repo and current conversation context.
2. Decide whether the input needs a full PRD plus issues, or issues only from an existing PRD/spec/plan.
3. Identify the intended outcome, major user flows, implementation seams, natural slice boundaries, and true sequencing constraints.
4. Create or update the canonical PRD when needed.
5. Draft dependency-ordered implementation issues.
6. Classify each issue as AFK or HITL and explain why.
7. Publish issues under `.scratch/<feature-slug>/issues/` only when they satisfy Definition Of Ready and can be written without overwriting existing user work.
8. Display a tree view of generated or updated files and the best execution order.
9. Report preserved existing issues and any stale issue warnings.

## Output Contract

When your work is done, return:

- a short note explaining whether you produced one feature package or multiple feature packages, and why
- the `.scratch/.../PRD.md` path for each generated or updated PRD
- the `.scratch/.../issues/*.md` paths for each generated issue
- any existing issue files preserved unchanged
- stale issue warnings, conflicts, or non-canonical layout notes
- the best execution order based on true blockers
- any remaining open questions or follow-up risks

When the user asks for file output, include exact file paths for created PRDs and issues.

## Tone

Decisive, structured, and execution-oriented. Exhaustive where it helps implementation. Challenge weak decomposition. Favor fewer, sharper, more vertical issues over layer-oriented ticket spam.
