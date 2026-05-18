# Blockers: Dual Model Selection and Reviewer Prompt Catalog

## Open Questions

- Should the reviewer prompt catalog start as a fixed built-in list or load from a dedicated tracked directory?
- Should the reviewer model be optional for legacy runs, or required whenever reviewer gating is enabled?

## Stop And Ask

- If the feature needs a new selection step that changes the current launch order.
- If the prompt catalog format would break existing prompt files.
- If verification requires external services, credentials, or destructive cleanup.

## Dangerous Or High-Risk Actions

- Deleting or rewriting ticket files under `.scratch/`.
- Changing git worktree or branch handling beyond the normal AFK launcher flow.
- Introducing remote prompt fetching, secret handling, or auth changes.

## Known Blockers

- None yet. The remaining work is specification, implementation, and verification.
