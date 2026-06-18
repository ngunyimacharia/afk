---
name: afk-config
description: Create or update repo-local AFK config (`afk.json`) from project context
---

Create or update `afk.json` in the repository root. This command is the setup path required before running AFK.

## Goal

Generate a minimal, valid AFK project config without asking the user test/readiness questions. Inspect the repository and decide the values from project evidence.

## Required Output File

Write `afk.json` at the repository root with this exact schema:

```json
{
  "testsEnabled": true,
  "testEnvFile": ".env.testing",
  "smokeTestCommand": "npm test -- tests/project-config.test.ts",
  "staticCheckCommands": ["npm run lint --silent"]
}
```

When the repository context, user request, or existing workflow shows that Linear support is desired, include a `linear` block. Do not include this block unless Linear setup is requested or clearly intended. The presence of a `linear` block enables Linear tracker mode; omitting it keeps AFK in scratch/local mode. There is no `provider` block.

```json
{
  "testsEnabled": true,
  "smokeTestCommand": "bun test tests/project-config.test.ts",
  "staticCheckCommands": ["bun run build"],
  "linear": {
    "teamId": "team-uuid-or-id",
    "labelName": "AFK",
    "workflowStates": {
      "ready": "Ready for AFK",
      "running": "AFK Running",
      "done": "Done",
      "handoff": "Needs Human"
    },
    "apiKeyEnv": "LINEAR_API_KEY"
  }
}
```

Concrete examples by common stack:

```json
{
  "testsEnabled": true,
  "smokeTestCommand": "npm test -- tests/smoke/project-config.test.ts",
  "staticCheckCommands": ["npm run lint --silent", "npm run typecheck --silent"]
}
```

```json
{
  "testsEnabled": true,
  "smokeTestCommand": "bun test tests/project-config.test.ts",
  "staticCheckCommands": ["bun run build"]
}
```

```json
{
  "testsEnabled": true,
  "testEnvFile": ".env.testing",
  "smokeTestCommand": "php artisan test tests/Feature/HealthCheckTest.php",
  "staticCheckCommands": ["php -l app/Console/Kernel.php"]
}
```

Rules:

- `testsEnabled` is required and must be boolean.
- `testEnvFile` is optional. Include it only when the repo clearly uses a test env file.
- `smokeTestCommand` is required only when `testsEnabled=true`.
- `smokeTestCommand` must use a concrete deterministic test file path from the repo. Do not use `{testFile}`.
- `staticCheckCommands` is optional but must be an array when present.
- `linear` is optional. Include it only when Linear support is desired. Its presence selects the Linear tracker; omitting it selects the scratch/local tracker.
- Do not include a `provider` block; `afk.json` has no `provider.kind` or `provider` key.
- `linear.teamId` is preferred for Linear execution. `linear.teamKey` may be used only when the consuming workflow supports resolving a team key; otherwise use the team ID.
- `linear.labelName` must name an existing dedicated AFK label.
- `linear.workflowStates.ready`, `running`, `done`, and `handoff` must name or identify existing Linear workflow states.
- `linear.apiKeyEnv` is optional and defaults to `LINEAR_API_KEY`. If a different credential variable is required, store only that variable name.
- Do not include `model` or any other keys.
- Do not include Linear API keys, tokens, or other secrets in `afk.json`.

## Steps

1. Inspect project files such as `package.json`, lockfiles, `composer.json`, `phpunit.xml*`, `deno.json*`, `Cargo.toml`, `go.mod`, `Makefile`, `README.md`, and visible test/config directories.
2. Determine whether tests are available and safe for AFK readiness.
3. Determine a smoke test command that runs a single deterministic test file when possible.
4. Determine static checks such as lint, typecheck, build, check, or format-check commands when they are safe and non-mutating.
5. Detect whether Linear support is desired from the user request, README/docs, existing Linear manifests, or Linear-related AFK workflows.
6. If Linear support is desired, identify the team ID or key, dedicated AFK label name, ready/running/done/handoff workflow state names or IDs, and credential env name.
7. If `LINEAR_API_KEY` or the chosen credential env var is available, use only read-only Linear API checks to confirm the label and workflow states already exist. Report any missing label or workflow state as a setup task; do not create Linear labels or workflow states automatically.
8. If Linear support is desired but the label or workflow states cannot be confirmed, still keep secrets out of `afk.json` and explain the missing setup tasks clearly in the response.
9. Create or update `afk.json` with only the approved schema.
10. Show the final `afk.json` content, document the required Linear credential env var, and list any Linear setup tasks that remain.

## Decision Guidance

- Node/Bun repos: prefer existing scripts from `package.json`.
- TypeScript/Node repos: prefer npm/pnpm/yarn scripts from `package.json` with a concrete test file path.
- Laravel repos: prefer `php artisan test <concrete test file>` when available, otherwise `vendor/bin/pest <file>` or `vendor/bin/phpunit <file>`.
- If `test` uses Bun, Vitest, Jest, or Node test runner, prefer a single-file command that names a concrete deterministic test file.
- PHP repos: prefer Pest/PHPUnit commands when config or dependencies indicate them.
- If tests exist but no reliable single-file command can be determined, set `testsEnabled=false` and explain why.
- Static checks must not mutate files. Avoid commands that include `--write`, `--fix`, or formatting writes.
- Linear setup checks are validation-only. Missing labels or workflow states must be reported to the user as setup tasks instead of being created by this workflow.

## Constraints

- Do not ask the user whether tests are enabled, what test command to use, or which static checks to run.
- Do not edit files other than `afk.json`.
- Do not run `afk sync` and do not modify global or local Git ignore files from this prompt.
- Do not commit or stage changes.
- Do not include secrets, environment contents, or machine-specific absolute paths in `afk.json`.
- Do not store `LINEAR_API_KEY` values or any Linear token values in `afk.json`; store only `linear.apiKeyEnv` when needed.
