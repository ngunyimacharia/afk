# Verification: Dual Model Selection and Reviewer Prompt Catalog

## Commands

| Command | Purpose | Expected pass condition | Evidence location |
| --- | --- | --- | --- |
| `bun test` | Run the automated test suite | All tests pass | `progress.jsonl` |
| `bun run build` | Verify the project still compiles | Build succeeds without errors | `progress.jsonl` |
| `bun run test --filter <relevant-tests>` | Run focused coverage for the new flow | Targeted selection and catalog tests pass | `progress.jsonl` |

## Manual Checks

- Start `afk` in a local terminal and confirm the launch flow asks for both a working model and a reviewer model.
- Confirm the reviewer prompt choice comes from a tracked catalog entry rather than free-form ad hoc input.
- Inspect the run metadata or summary artifact to confirm the chosen reviewer model and prompt were recorded.

## Evidence Rules

- Record verification results in `progress.jsonl`.
- Include command, status, timestamp, and artifact path when available.
- Do not rely on passing tests unless they cover the requirement being claimed.
