# AFK

AFK is a TypeScript implementation of an autonomous local-workflow runner built around markdown tickets in `.scratch/`.

It currently provides four core behaviors:

- AFK ticket discovery and launch planning
- deterministic worktree and branch preparation in TypeScript
- runtime logging, summary reporting, and conservative cleanup
- asset sync for vendored harness commands, prompts, agents, and skills
- independent execution and reviewer model resolution with a deterministic reviewer prompt catalog

## Current Surface Area

- `afk`: interactive launch wizard (harness, model, feature multiselect, concurrency) followed by dependency-aware scheduled work
- `afk summary`: read-only summary of AFK work from ticket files plus runtime metadata
- `afk cleanup`: dry-run-first cleanup for terminal AFK tickets and attributable runtime artifacts
- `afk sync`: sync vendored harness assets into supported user-level harness config directories and configure Git global ignores for AFK runtime directories

The current entrypoint is `runAfk()` in `src/cli.ts`. The implementation already supports the command behaviors above, but this repo is not yet packaged as an installed shell binary.

## Setup

Requirements:

- Bun
- git
- OpenCode, Claude Code, Kimi Code, Codex, or PI installed and authenticated for the harnesses you want to execute

Install dependencies and verify the checkout:

```bash
bun install
bun run test
bun run build
```

AFK expects tickets to live under `.scratch/<feature-slug>/issues/`. Create `.scratch/` locally if it does not already exist; runtime logs and metadata are also written there.

### Codex Setup

Codex uses the OpenAI Codex SDK. Before launching a Codex ticket:

1. Install the Codex CLI/SDK and authenticate it. Docker runs mount the host `~/.codex` subscription config; `OPENAI_API_KEY` is optional when that config is present.
2. Run `afk` interactively; the launch wizard shows Codex only when model discovery returns at least one usable launch model.
3. Codex always appears with the built-in `codex/default` model, which lets Codex use its configured default model.
4. Optionally set `AFK_CODEX_MODELS` to a comma-separated list of explicit Codex model names to add more launch choices (for example, `AFK_CODEX_MODELS="gpt-5.1-codex,gpt-5.1-codex-mini"`). AFK prefixes each entry with `codex/` in the picker and sends only the suffix to Codex.
5. Override sandbox, approval, and network defaults only when the repo and ticket require it. See [Codex Configuration](#codex-configuration) for the available environment overrides.

## Usage

Build and install a local executable into a user PATH directory:

```bash
bun run install:local
```

This always builds locally with Bun's `--compile` support. It does not use hosted builds or download prebuilt AFK binaries. By default, the installer writes `afk` to the first writable user-owned directory already in `PATH`; if none is found, it writes to `~/.local/bin` on Linux/macOS or `%USERPROFILE%\bin` on Windows and prints a PATH reminder. Set `AFK_INSTALL_DIR` to choose a specific install directory.

Build only, without installing to PATH:

```bash
bun run build:exe
```

Run the installed executable:

```bash
afk
afk summary
afk cleanup
afk cleanup "confirm cleanup plan"
afk sync
```

The internal runner still recognizes the older command names for compatibility with existing integrations, but the local executable is installed as a single `afk` command.

Typical workflow:

1. Run `afk sync` to install AFK harness assets.
2. Run the synced `/afk-config` command once per repo to create local `afk.json`.
3. Add or update issue files under `.scratch/<feature-slug>/issues/`.
4. Mark tickets with an eligible status such as `ready-for-agent`.
5. Run AFK in an interactive terminal and complete the prompts for harness, model, and tickets.
6. Run `afk summary` to inspect issue summaries and runtime metadata.
7. Run `afk cleanup` first as a dry run, then repeat with `confirm cleanup plan` only when the plan is correct.

## Project Config

`afk` requires `afk.json` in the repo root before launching work. If it is missing, AFK exits and asks you to run `/afk-config` in a synced harness. The config file is added to AFK's global Git ignore entries because it represents local project preferences. The `/afk-config` slash command inspects the repo, generates the readiness config, writes `afk.json`, and reports the chosen commands.

Example:

```json
{
  "testsEnabled": true,
  "testEnvFile": ".env.testing",
  "smokeTestCommand": "bun test tests/project-config.test.ts",
  "staticCheckCommands": ["npm run lint --silent", "npm run typecheck --silent"]
}
```

Common concrete examples by stack:

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

Fields:

- `testsEnabled`: required boolean. When `false`, AFK skips test execution readiness checks.
- `testEnvFile`: optional repo-relative file copied into AFK worktrees when present.
- `smokeTestCommand`: required when `testsEnabled=true`; must reference a concrete deterministic test file path from the repo.
- `staticCheckCommands`: optional ordered command list; any failure blocks readiness.

## Ticket Model

AFK uses the local markdown tracker under `.scratch/`:

```text
.scratch/
  execution.json
  <feature-slug>/
    PRD.md
    execution.json
    issues/
      01-some-issue.md
```

Key conventions:

- one feature per directory
- implementation issues live under `.scratch/<feature-slug>/issues/`
- opening YAML frontmatter `status` is the operational status
- YAML frontmatter is the canonical machine-readable source; legacy `Status:` lines are rejected
- issue frontmatter may include `Depends-On` with same-feature issue basenames
- PRD frontmatter may include `Depends-On-Features` with feature slugs
- `execution.json` files are derived AFK scheduler state and may be regenerated

Eligible launch tickets are discovered from `.scratch/*/issues/*.md`. Terminal tickets, including `ready-for-human`, are excluded from relaunch.

Launch behavior notes:

- `afk` launch is interactive-only and requires a TTY (no CI/non-interactive launch mode in this pass).
- `afk` launch requires repo-local `afk.json`; run `/afk-config` first.
- prompt order is harness -> model -> reviewer model -> feature multiselect -> global concurrency.
- selectable harnesses are `OpenCode`, `Claude`, `Codex`, and `PI` when their model discovery returns at least one launch model.
- Codex appears in the harness prompt with the built-in `codex/default` model option. Install and authenticate Codex before launching Codex tickets so the SDK-backed execution can start real threads.
- PI appears in the harness prompt when `pi/default` is available. Install the PI SDK and authenticate it before launching PI tickets; AFK sends the prepared worktree path and a phase-appropriate tool allowlist to the PI agent.
- no prompt preselects a default option.
- canceling any prompt exits without creating worktrees or runtime artifacts.
- global concurrency defaults to `3` and is persisted as a launch preference.
- selected features run through dependency-aware ticket waves; independent tickets may run in parallel.
- dependent feature branches use a linear stack from `afk/<upstream-feature>`; fan-in branch automation is deferred.
- the launch wizard asks how completed features should be handled: merge each completed feature branch into the base branch, or create a GitHub pull request for each completed feature branch. There is no "leave branches for manual inspection" path; PR creation replaces it.
- the feature completion action is persisted as a launch preference. Legacy `mergeBackToBase: true` resolves to merge-to-base and `mergeBackToBase: false` resolves to PR creation.
- completed features (every selected ticket completed successfully) are eligible for the chosen completion action. For `create-pr`, AFK pushes the feature branch and opens a GitHub PR with `gh pr create`, using a discovered PR template when one exists, and reports the PR URL (or a per-feature failure reason) in run progress and final output.

## Codex Configuration

Codex model discovery always includes `codex/default`, which lets Codex use its configured default model. Set `AFK_CODEX_MODELS` to a comma-separated list of explicit Codex model names to add more launch choices; AFK prefixes each entry with `codex/` in the model picker and sends only the suffix to Codex.

Example:

```bash
AFK_CODEX_MODELS="gpt-5.1-codex,gpt-5.1-codex-mini" afk
```

Codex execution defaults are chosen for autonomous AFK runs inside prepared worktrees:

- `sandboxMode`: `workspace-write`
- `approvalPolicy`: `never`
- `networkAccessEnabled`: `false`

Override them only when the repo and ticket require different Codex behavior:

- `AFK_CODEX_SANDBOX`: `read-only`, `workspace-write`, or `danger-full-access`
- `AFK_CODEX_APPROVAL`: `never`, `on-request`, `on-failure`, or `untrusted`
- `AFK_CODEX_NETWORK`: `true`, `false`, `1`, `0`, `yes`, or `no`

Invalid override values are ignored and fall back to the defaults above.

## PI Configuration

PI model discovery always includes `pi/default`, which lets PI use its configured default model. Set `AFK_PI_MODELS` to a comma-separated list of explicit PI model names (in `provider/model` form where possible) to add more launch choices; AFK prefixes each entry with `pi/` in the model picker and sends only the suffix to PI.

Example:

```bash
AFK_PI_MODELS="openai/gpt-5.1-codex,anthropic/claude-opus" afk
```

PI execution uses the host PI configuration under `~/.pi/agent`:

- the prepared worktree path is passed as the PI session working directory
- execution mode receives the SDK built-in tool allowlist (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`)
- reviewer mode receives a read-only diagnostic allowlist (`read`, `grep`, `find`, `ls`)
- pull-request mode receives a limited allowlist (`read`, `bash`, `grep`, `find`, `ls`) so it can push branches and create PRs through shell commands without file mutation tools

PI has no interactive permission prompt, so AFK relies on these SDK tool allowlists to enforce phase boundaries. If PI's SDK does not support a tool allowlist option, the boundaries are enforced only by the prompt instructions and the existing permission coordinator.

## Runtime Artifacts

AFK writes runtime state under `.scratch/.opencode-afk-logs/`:

- per-ticket logs: `.scratch/.opencode-afk-logs/<feature>-<issue>.log`
- runtime metadata: `.scratch/.opencode-afk-logs/runtime-metadata/<feature>-<issue>.json`
- sentinels: `.scratch/.opencode-afk-logs/sentinels/<feature>-<issue>.{done,failed}`

`afk summary` remains issue-file-first. Runtime metadata is readable by default. Raw log inspection is intended to remain permission-gated by caller policy.

## Known Limitations

- Codex and PI both require the relevant SDK and host credentials to be installed and authenticated before they appear in the launch wizard.
- Codex event parsing is defensive and based on observed Codex SDK event shapes; events that diverge from those shapes may not produce detailed progress messages.
- PI event parsing is similarly defensive because the PI SDK event schema is not stable in this pass; some PI-specific event types may be summarized generically.
- PI tool allowlists enforce phase boundaries through the SDK when supported; otherwise, phase restrictions rely on prompt instructions and the existing permission coordinator.
- PI sessions are durable per ticket but are not resumed across AFK restarts in this pass; the session id is captured in runtime metadata for inspection.
- Real network calls to Codex or PI providers are not exercised by the automated test suite; manual verification with installed providers is required before relying on either harness in production.

## Development

Install dependencies and run checks:

```bash
bun install
bun run test
bun run build
```

## Repo Layout

- `src/`: AFK implementation
- `src/prompts/`: internal AFK runner prompt templates, not synced into OpenCode
- `tests/`: Node test runner coverage for AFK behavior
- `docs/`: repo documentation
- `artifacts/`: tracked harness assets used by `afk sync`
- `.scratch/`: local issue tracker and AFK runtime workspace

## Further Docs

- `docs/README.md`
- `docs/workflow.md`
- `docs/operations.md`

## Credits

AFK's local markdown ticket workflow and agent-oriented conventions were informed by Matt Pocock's public agent workflow materials, which served as reference and inspiration.
