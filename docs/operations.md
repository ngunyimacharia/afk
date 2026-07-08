# AFK Operations

## Summary Reporting

Summary reporting is implemented by `SummaryReporter` in `src/summary-reporter.ts`.

Current behavior:

- `afk-summary` is read-only
- issue files are the default source of truth
- repeated `## AFK Summary` attempts are reported
- missing summary blocks are called out explicitly
- readable runtime metadata may supplement the report

The current implementation can accept a permission gate for raw log access, but the default command path does not inspect raw logs.

## Cleanup

Cleanup is implemented in `src/cleanup.ts` and dispatched from `src/cli.ts`.

Current behavior:

- `afk-cleanup` always prints a dry-run plan first
- deletion only runs when the exact confirmation phrase is supplied
- only terminal ticket files and attributable runtime artifacts are eligible
- `ready-for-human` tickets are preserved
- worktrees, branches, and processes are preserved

Terminal cleanup statuses currently include:

- `done`
- `closed`
- `complete`
- `resolved`

The dry-run output includes:

- terminal tickets to delete
- matching logs and metadata to delete
- preserved tickets and artifacts
- feature directories that become removable after terminal cleanup

## Runtime Artifact Layout

Runtime data is stored under `.scratch/.opencode-afk-logs/`.

```text
.scratch/.opencode-afk-logs/
  <feature>-<issue>.log
  runtime-metadata/
    <feature>-<issue>.json
  sentinels/
    <feature>-<issue>.done
    <feature>-<issue>.failed
```

Runtime metadata currently records:

- ticket path
- feature slug and issue name
- log path
- start time and epoch
- done and failed sentinel paths
- normalized runtime status
- execution provider details
- provider session identifiers
- unsafe or incomplete capture reasons when applicable

## Sandcastle Docker Runtime Image

Docker-isolated Sandcastle runs use the v1 runtime image contract named `afk-runtime:latest`. AFK does not build,
pull, or publish this image during launch in v1; operators are responsible for making that image available to the
local Docker daemon before selecting Docker isolation.

The image must contain:

- the AFK code or installed AFK runtime needed to execute ticket phases
- Node or Bun support for the installed AFK runtime
- Git and standard shell tools used by AFK prompts and readiness commands
- OpenCode, Claude Code, and Codex execution dependencies when those providers are selectable
- an executable phase capability probe at `afk-sandcastle-executor capabilities`

The capability probe must print the token `afk.phase-executor.v1` on stdout. AFK validates Docker-mode launches by
checking that `afk-runtime:latest` exists and that running:

```bash
docker run --rm afk-runtime:latest afk-sandcastle-executor capabilities
```

returns that capability token. A missing image blocks the run with `missing-image`; an image without the required
capability blocks the run with `missing-phase-executor`.

The v1 container path contract is stable:

- worktree mount target: `/workspace/afk-worktree`
- OpenCode config target: `/home/sandbox/.config/opencode`
- Claude Code config target: `/home/sandbox/.claude`
- Codex config target: `/home/sandbox/.codex`

Provider config sources remain host-managed by AFK provider selection. The Docker runtime contract does not copy
secrets, create temporary credential volumes, or support alternate image registries in v1.

## Asset Sync

Asset sync is implemented under `src/sync/`.

`afk sync` currently copies vendored markdown assets from:

- `artifacts/skills/`
- `artifacts/prompts/`

into each harness's config directory:

- OpenCode: `$XDG_CONFIG_HOME/opencode/`, or `~/.config/opencode/`
- Claude Code: `~/.claude/`
- Kimi Code: `$KIMI_CODE_HOME/`, or `~/.kimi-code/`
- Codex: `$HOME/.agents/skills/<skill>/SKILL.md`
- PI: `$HOME/.pi/agent/skills/<skill>/SKILL.md` and `$HOME/.pi/agent/prompts/`

Codex skills are synced at the user level because current Codex skill discovery reads from `$HOME/.agents/skills/`; AFK does not install repo-local Codex skills in this pass. PI assets are synced to the host agent directory under `~/.pi/agent`.

Current sync behavior:

- creates missing destination directories
- classifies files as created, updated, unchanged, or skipped
- leaves identical files untouched
- blocks destination root escapes
- does not delete destination files by default
- reminds the user to restart each harness after sync

Internal runner prompts live under `src/prompts/` and are not syncable artifacts.

## Verification

The repository currently uses:

```bash
npm test
npm run build
```

Tests cover:

- ticket parsing and launch selection
- worktree preparation and prompt construction
- runtime store and single-ticket execution
- scheduler behavior
- summary reporting and summary-presence gating
- cleanup planning and execution
- asset sync engine and harness sync mappings
- Codex configuration parsing and SDK thread option defaults
- PI model discovery, session execution, and event mapping
