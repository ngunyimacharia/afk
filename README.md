# AFK

AFK is a TypeScript implementation of an autonomous local-workflow runner built around markdown tickets in `.scratch/`.

It currently provides four core behaviors:

- AFK ticket discovery and launch planning
- deterministic worktree and branch preparation in TypeScript
- runtime logging, summary reporting, and conservative cleanup
- asset sync for vendored OpenCode commands, prompts, and agents

## Current Surface Area

- `afk`: interactive launch wizard (harness, model, ticket multiselect) followed by scheduled work
- `afk summary`: read-only summary of AFK work from ticket files plus runtime metadata
- `afk cleanup`: dry-run-first cleanup for terminal AFK tickets and attributable runtime artifacts
- `afk sync`: sync vendored OpenCode assets from `artifacts/opencode/` into `private_dot_config/opencode/`

The current entrypoint is `runAfk()` in `src/cli.ts`. The implementation already supports the command behaviors above, but this repo is not yet packaged as an installed shell binary.

## Setup

Requirements:

- Bun
- git

Install dependencies and verify the checkout:

```bash
bun install
bun run test
bun run build
```

AFK expects tickets to live under `.scratch/<feature-slug>/issues/`. Create `.scratch/` locally if it does not already exist; runtime logs and metadata are also written there.

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

1. Add or update issue files under `.scratch/<feature-slug>/issues/`.
2. Mark tickets with an eligible status such as `ready-for-agent`.
3. Run AFK in an interactive terminal and complete the prompts for harness, model, and tickets.
4. Run `afk summary` to inspect issue summaries and runtime metadata.
5. Run `afk cleanup` first as a dry run, then repeat with `confirm cleanup plan` only when the plan is correct.

## Ticket Model

AFK uses the local markdown tracker under `.scratch/`:

```text
.scratch/
  <feature-slug>/
    PRD.md
    issues/
      01-some-issue.md
```

Key conventions:

- one feature per directory
- implementation issues live under `.scratch/<feature-slug>/issues/`
- `Status:` near the top of the issue file is the operational status
- YAML frontmatter is the canonical machine-readable source when present

Eligible launch tickets are discovered from `.scratch/*/issues/*.md`. Terminal tickets, including `ready-for-human`, are excluded from relaunch.

Launch behavior notes:

- `afk` launch is interactive-only and requires a TTY (no CI/non-interactive launch mode in this pass).
- prompt order is harness -> model -> ticket multiselect.
- the only harness currently supported is `OpenCode`.
- no prompt preselects a default option.
- canceling any prompt exits without creating worktrees or runtime artifacts.

## Runtime Artifacts

AFK writes runtime state under `.scratch/.opencode-afk-logs/`:

- per-ticket logs: `.scratch/.opencode-afk-logs/<feature>-<issue>.log`
- runtime metadata: `.scratch/.opencode-afk-logs/runtime-metadata/<feature>-<issue>.json`
- sentinels: `.scratch/.opencode-afk-logs/sentinels/<feature>-<issue>.{done,failed}`

`afk summary` remains issue-file-first. Runtime metadata is readable by default. Raw log inspection is intended to remain permission-gated by caller policy.

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
- `docs/agents/`: issue-tracker and triage conventions for agents
- `artifacts/`: tracked harness assets used by `afk sync`
- `.scratch/`: local issue tracker and AFK runtime workspace

## Further Docs

- `docs/README.md`
- `docs/workflow.md`
- `docs/operations.md`
- `docs/agents/issue-tracker.md`
- `docs/agents/triage-labels.md`

## Credits

AFK's local markdown ticket workflow and agent-oriented conventions were informed by Matt Pocock's public agent workflow materials, which served as reference and inspiration.
