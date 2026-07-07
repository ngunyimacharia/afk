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
- OpenCode, Claude Code, Codex, and PI execution dependencies when those providers are selectable
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
- PI config target: `/home/sandbox/.pi`

Before any Docker-mode worktree execution starts, AFK fails closed if Docker is unavailable, `afk-runtime:latest` is
missing, the image lacks `afk.phase-executor.v1`, or the selected implementation/reviewer provider credentials are not
available. Provider credentials remain host-managed by AFK provider selection and are passed into the container only via
existing auth env vars and required config mounts:

- OpenCode: `OPENCODE_AUTH` and `$XDG_CONFIG_HOME/opencode` (or `~/.config/opencode`) mounted at `/home/sandbox/.config/opencode`
- Claude Code: `ANTHROPIC_API_KEY` and `~/.claude` mounted at `/home/sandbox/.claude`
- Codex: `OPENAI_API_KEY` and `~/.codex` mounted at `/home/sandbox/.codex`
- PI: `PI_API_KEY` and `~/.pi` mounted at `/home/sandbox/.pi`

No-sandbox launches intentionally bypass Docker-specific validation and continue to use host provider configuration.
The Docker runtime contract does not copy secrets, create temporary credential volumes, silently fall back to
no-sandbox, or support alternate image registries in v1.

### Docker E2E acceptance evidence

Before marking Docker-mode harness verification complete, operators must run one real Docker-isolated ticket for each
supported harness (`OpenCode`, `Claude`, `Codex`, and `PI`) in an environment with Docker, `afk-runtime:latest`, and the
provider credentials/config mounts listed above. For each verified run, retain evidence that:

- AFK selected `sandbox: docker` and did not fall back to no-sandbox.
- The run created a Docker container and completed implementation/review phases.
- Runtime cleanup removed the container or recorded the cleanup command for any leftover container.
- `afk summary` reports `sandbox: docker` plus the container name or id for the run.

Do not treat prerequisite-validation tests as a substitute for this live E2E matrix.

After the four live runs complete, run `bun run verify:docker-e2e` from the repository root. The verifier first requires
`afk-runtime:latest` to be present locally, then reads `.scratch/sandcastle-runtime/runs`, requires one completed Docker
run with a container identity for each supported harness, renders `afk summary`, and fails if the summary output does not
include `sandbox: docker` plus the recorded container name or id. A failing verifier means AC6/AC7 are still incomplete
and the ticket must remain blocked until the missing runtime image, provider run, or summary evidence is present.

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
