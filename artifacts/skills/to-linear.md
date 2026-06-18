---
name: to-linear
description: Plan Linear parent and sub-issues, then invoke AFK Linear helpers to create them with dependencies
---

# To Linear

Turn the current conversation context, an existing PRD, a spec, or an implementation plan into Linear parent issues with executable Linear sub-issues.

This skill uses Linear. It does not write Local Markdown scratch packages, `.scratch/<feature>/PRD.md`, or `.scratch/<feature>/issues/*.md`. Use `to-scratch` instead when the requested output is local AFK Markdown.

## Prerequisites

`afk.json` must include a Linear `projectId` for the repository. All issues created by this skill are assigned to that project, and AFK discovery only returns issues that belong to it.

Configuration precedence:

- For `provider.kind: 'linear-graphql'`, use `provider.projectId`.
- For the legacy `linear` runtime block, use `linear.projectId`.
- When both are present, `provider.projectId` takes precedence over `linear.projectId`.

Example legacy configuration:

```json
{
  "testsEnabled": false,
  "staticCheckCommands": [],
  "linear": {
    "teamId": "team-uuid",
    "projectId": "project-uuid",
    "afkLabel": "AFK",
    "workflowStates": {
      "ready": "Ready for agent",
      "running": "In Progress",
      "done": "Done",
      "handoff": "Needs Handoff"
    }
  },
  "provider": { "kind": "scratch" }
}
```

Example `linear-graphql` provider configuration:

```json
{
  "testsEnabled": false,
  "staticCheckCommands": [],
  "provider": {
    "kind": "linear-graphql",
    "team": { "id": "team-uuid" },
    "projectId": "project-uuid",
    "afkLabelName": "AFK",
    "workflowStates": {
      "ready": { "name": "Ready for agent" },
      "running": { "name": "In Progress" },
      "done": { "name": "Done" },
      "handoff": { "name": "Needs Handoff" }
    }
  }
}
```

## Default Behavior

- Inspect the repository and relevant docs before planning when you have not already done so.
- Draft PRD-like parent issue context that captures the user outcome, background, goals, non-goals, requirements, risks, and open questions.
- Break the work into narrow, dependency-ordered Linear sub-issues that are ready for AFK execution.
- Prefer vertical slices that deliver coherent value over weak horizontal decomposition such as "backend", "frontend", or "tests" issues.
- Preserve existing Linear work. Do not duplicate, overwrite, close, rename, or restructure existing Linear issues unless the user explicitly asks for that change.
- Produce a Linear plan manifest and invoke AFK helper functionality for all Linear mutations.
- Do not call Linear GraphQL, REST, SDKs, or raw API mutations directly from the skill.

## Repo Grounding

During exploration, look for:

- project type, language, framework, and stack
- architectural boundaries and existing module seams
- docs such as `README`, `CONTEXT.md`, `CONTEXT-MAP.md`, ADRs, feature specs, and glossary docs
- existing test patterns and nearby prior art
- existing Linear references in docs or configuration
- agent index docs or planning guidance, if relevant to execution readiness

## Linear Planning Guidance

Each parent issue should provide enough product and implementation context for review and downstream execution without becoming a line-by-line design doc.

Include in parent descriptions:

- the user or system outcome
- background and current behavior
- goals and non-goals
- requirements and externally observable success conditions
- UX, API, CLI, data, or operational behavior when relevant
- dependency notes and feature-level blockers
- risks, edge cases, and open questions

Each sub-issue should be a small executable slice with:

- a clear outcome
- explicit scope boundaries
- observable acceptance criteria
- concrete verification steps
- enough local context to execute without reopening the whole plan
- `dependsOn` only for true blockers, not preferred ordering

## Manifest Requirements

Create a temporary JSON manifest for the AFK helper. Do not place it under `.scratch/` and do not commit it.

Manifest shape:

```json
{
  "parents": [
    {
      "ref": "parent",
      "title": "Parent issue title",
      "description": "PRD-like parent issue context.",
      "subIssues": [
        {
          "ref": "api-slice",
          "aliases": ["api"],
          "title": "Implement the API slice",
          "description": "Executable issue context with acceptance criteria and verification."
        },
        {
          "ref": "ui-slice",
          "title": "Implement the UI slice",
          "description": "Executable issue context with acceptance criteria and verification.",
          "dependsOn": ["api-slice"]
        }
      ]
    }
  ]
}
```

Rules:

- `parents` must be a non-empty array.
- `ref`, `title`, and `description` are required non-empty strings for each parent and sub-issue.
- `subIssues` must be non-empty for each parent.
- `dependsOn` references are same-parent sub-issue refs or aliases only.
- Use stable, human-readable refs that make dependency reports understandable.
- Use `aliases` only to preserve existing names from user language or prior plans.
- Use `updateIntent` only when the helper should append explicit update intent to a created issue description.

## Mutation Command

After validating the plan, invoke the AFK Linear helper from the repository root:

```sh
afk linear-plan /path/to/linear-plan-manifest.json
```

The helper is responsible for Linear mutations, including parent issue creation, sub-issue creation, AFK label application, ready workflow state assignment, and Linear blocked-by relations from `dependsOn`.

If helper setup fails, report the setup gap exactly enough for the user to fix it, such as missing Linear config, missing API key environment variable, missing AFK label, or missing ready workflow state.

## Existing Linear Work

When the request references existing Linear issues:

- inspect the relevant existing issue details when available before planning new work
- preserve existing parent issues, sub-issues, labels, states, descriptions, comments, and dependency relations unless the user explicitly asks to change them
- prefer adding only the missing executable sub-issues needed to satisfy the request
- report any existing issues that were intentionally preserved
- report stale, duplicate, ambiguous, or conflicting Linear work instead of silently replacing it

## Final Report

Always report:

- created parent Linear issue keys and URLs
- created sub-issue keys and URLs grouped by parent
- dependency order used for execution
- blocked-by dependency relations created from the manifest
- existing Linear work preserved
- setup gaps, helper errors, or caveats
- the manifest path used, if it is useful for debugging and does not contain secrets

Do not report local scratch package paths because this skill does not create them.
