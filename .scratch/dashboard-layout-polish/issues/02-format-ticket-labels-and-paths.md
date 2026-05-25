---
status: done
---

Status: done

# Format Ticket Labels and Paths in Dashboard

## Why

Dashboard panels display full ticket labels like `feat-a/01-do-thing` and absolute file paths. The feature prefix is repetitive in a single-feature view, and absolute paths leak repo layout and take up horizontal space.

## Scope

Includes:
- Implement `stripFeaturePrefix` helper to remove `feature/` from ticket labels in dashboard output
- Implement `formatPath` helper to show repo-relative paths for files inside the repo and basename for outside-repo files
- Wire `repoRoot` through `LiveRunViewOptions`, `DashboardProxy` options, and `OpenTuiDashboardOptions`
- Update existing tests to assert on stripped labels and formatted paths
- Add new test covering both inside-repo and outside-repo path formatting

Excludes:
- Changing the underlying `TicketRecord` label values
- Modifying how paths are stored in snapshots or metadata

## Acceptance Criteria

1. Ticket labels in the Tickets, Events, Action Needed, and Details panels show the issue name without the feature prefix.
2. The Details panel shows a repo-relative path when the ticket file is inside the repo, or a basename when it is outside.
3. `repoRoot` is passed from CLI through to the dashboard renderer.
4. All dashboard view tests pass and typecheck is clean.

## Verification

- Automated tests: `tests/opentui-dashboard-view.test.ts` updated with assertions for stripped labels and formatted paths.
- Run `npm test` and confirm all tests pass.
- Run `npx tsc --noEmit` and confirm no type errors.

## Comments

## AFK Summary

- Timestamp: 2026-05-25
- Session/run ID: dashboard-layout-polish/02-format-ticket-labels-and-paths
- Tracker status: done
- Outcome: implemented stripFeaturePrefix and formatPath helpers, wired repoRoot through dashboard options, updated tests
- Commits: `feat(dashboard): strip feature prefix from labels and format paths`
- Files/areas touched: `src/cli.ts`, `src/live-run-view.ts`, `src/opentui-dashboard.ts`, `tests/opentui-dashboard-view.test.ts`
- Tests/checks run: `npm test`, `npx tsc --noEmit`
- Blockers/errors: none
- Next action: none
