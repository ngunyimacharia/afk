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
- Do not include `model` or any other keys.

## Steps

1. Inspect project files such as `package.json`, lockfiles, `composer.json`, `phpunit.xml*`, `deno.json*`, `Cargo.toml`, `go.mod`, `Makefile`, `README.md`, and visible test/config directories.
2. Determine whether tests are available and safe for AFK readiness.
3. Determine a smoke test command that runs a single deterministic test file when possible.
4. Determine static checks such as lint, typecheck, build, check, or format-check commands when they are safe and non-mutating.
5. Create or update `afk.json` with only the approved schema.
6. Show the final `afk.json` content and a short explanation of the chosen commands.

## Decision Guidance

- Node/Bun repos: prefer existing scripts from `package.json`.
- TypeScript/Node repos: prefer npm/pnpm/yarn scripts from `package.json` with a concrete test file path.
- Laravel repos: prefer `php artisan test <concrete test file>` when available, otherwise `vendor/bin/pest <file>` or `vendor/bin/phpunit <file>`.
- If `test` uses Bun, Vitest, Jest, or Node test runner, prefer a single-file command that names a concrete deterministic test file.
- PHP repos: prefer Pest/PHPUnit commands when config or dependencies indicate them.
- If tests exist but no reliable single-file command can be determined, set `testsEnabled=false` and explain why.
- Static checks must not mutate files. Avoid commands that include `--write`, `--fix`, or formatting writes.

## Constraints

- Do not ask the user whether tests are enabled, what test command to use, or which static checks to run.
- Do not edit files other than `afk.json`.
- Do not run `afk sync` and do not modify global or local Git ignore files from this prompt.
- Do not commit or stage changes.
- Do not include secrets, environment contents, or machine-specific absolute paths in `afk.json`.
