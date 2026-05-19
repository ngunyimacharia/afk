# Issue tracker: Local Markdown

Issues and PRDs for this repo live as markdown files under `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The PRD is `.scratch/<feature-slug>/PRD.md`
- Implementation issues are `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state is recorded as a `Status:` line near the top of each issue file
- Machine-readable ticket metadata should use YAML frontmatter when present
- Same-feature issue dependencies are recorded as `Depends-On` frontmatter entries using issue basenames without `.md`
- Comments and conversation history append under a `## Comments` heading

## Example layout

```text
.scratch/
  checkout-redesign/
    PRD.md
    issues/
      01-cart-summary.md
      02-payment-form.md
```

## When a skill says "publish to the issue tracker"

Create a new file in the appropriate `.scratch/<feature-slug>/` location, creating directories if needed.

## When a skill says "fetch the relevant ticket"

Read the referenced markdown file directly.

## Execution Order

Issues may include same-feature dependencies in YAML frontmatter:

```md
---
status: ready-for-agent
Depends-On:
  - 01-foundation
  - 02-shared-types
---
```

- Use issue basenames only, e.g. `01-foundation`.
- Do not include paths or `.md` extensions.
- Missing or empty `Depends-On` means no issue blockers.
- AFK derives `.scratch/<feature-slug>/execution.json` from issue markdown; this file is CLI-managed and can be regenerated.
- Tickets in the same derived wave may run in parallel subject to global concurrency.

Feature-level dependencies live in `.scratch/<feature-slug>/PRD.md` frontmatter:

```md
---
Depends-On-Features:
  - auth-core
---
```

- Use exact `.scratch/<feature-slug>` directory slugs.
- AFK derives workspace state in `.scratch/execution.json` for selected feature DAGs.
- First-pass stacked branch automation supports linear stacks only; fan-in requires manual handling.

## Automated Code Test Expectations

Every implementation issue must include automated code test expectations in its Verification section:

- Name the automated code tests to add or run.
- If no automated code test is appropriate, the issue must explicitly say so and provide fallback verification (manual steps, demo, logs, etc.).
- This convention distinguishes automated code tests from manual checks or non-code verification.
