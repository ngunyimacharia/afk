---
status: done
---

Status: done

# Smooth Spinner and Ticket Cleanup

## Why

The dashboard and progress-line spinners used choppy 4-frame sequences, and ticket rows appended the latest message snippet, creating visual noise.

## Scope

Includes:
- Replace 4-frame braille spinner in dashboard with 10-frame smooth sequence
- Reduce dashboard spinner refresh interval from 1000 ms to 200 ms
- Replace 4-frame ASCII spinner in progress-line with 15-frame block-wave sequence
- Remove `latestMessage` snippet from dashboard ticket rows
- Update tests to assert new spinner characters and interval

Excludes:
- Changing spinner interval in progress-line (120 ms is acceptable)
- Altering event or details panel message display

## Acceptance Criteria

1. Dashboard spinner uses at least 8 frames and refreshes at 200 ms.
2. Progress-line spinner uses at least 8 frames.
3. Ticket rows show only selection indicator, stripped label, and state icon.
4. All dashboard-view and progress-line tests pass.

## Verification

- Automated tests: `tests/opentui-dashboard-view.test.ts` and `tests/progress-line.test.ts` updated.
- Run `npm test` and confirm all tests pass.
- Run `npx tsc --noEmit` and confirm no type errors.

## Comments

## AFK Summary

- Timestamp: 2026-05-26
- Session/run ID: dashboard-style-refresh/02-smooth-spinner-and-ticket-cleanup
- Tracker status: done
- Outcome: expanded dashboard spinner to 10 frames, reduced interval to 200 ms, expanded progress-line spinner to 15 frames, removed latestMessage from ticket rows, updated tests
- Commits: `refactor(dashboard): smooth spinners and clean ticket rows`
- Files/areas touched: `src/opentui-dashboard.ts`, `src/progress-line.ts`, `tests/opentui-dashboard-view.test.ts`, `tests/progress-line.test.ts`
- Tests/checks run: `npm test`, `npx tsc --noEmit`
- Blockers/errors: none
- Next action: none
