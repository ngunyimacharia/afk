import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runAfk } from '../src/cli.js';

test('afk-summary is read-only and issue-file-first', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  const metadataDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata');
  mkdirSync(issuesDir, { recursive: true });
  mkdirSync(metadataDir, { recursive: true });
  writeFileSync(
    path.join(issuesDir, '01.md'),
    `---
feature: feat
status: completed
---

## AFK Summary
Timestamp: 2026-05-18T00:00:00.000Z
Outcome: completed
`,
  );
  writeFileSync(
    path.join(metadataDir, 'feat-01.json'),
    JSON.stringify(
      {
        TICKET_PATH: path.join(issuesDir, '01.md'),
        FEATURE_SLUG: 'feat',
        ISSUE_NAME: '01',
        LOG_PATH: path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-01.log'),
        START_TIME: '2026-05-18T00:00:00.000Z',
        START_EPOCH: 1,
        DONE_SENTINEL_PATH: path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'sentinels', 'feat-01.done'),
        FAILED_SENTINEL_PATH: path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'sentinels', 'feat-01.failed'),
        STATUS: 'completed',
        EXECUTION_PROVIDER: 'opencode',
        PROVIDER_SESSION_ID: 'session-1',
        PROVIDER_SESSION_REMOVABLE: true,
        INSPECTION_PROVIDER: null,
        INSPECTION_TARGET_IDENTIFIER: null,
        UNSAFE_REASON: null,
        REVIEW_CYCLE_HISTORY: [],
        PHASE_HISTORY: [
          {
            name: 'execution',
            startTime: '2026-05-18T00:00:00.000Z',
            endTime: '2026-05-18T00:00:09.000Z',
            durationMs: 9000,
            cycle: 1,
          },
        ],
      },
      null,
      2,
    ),
  );
  const originalArg = process.argv[2];
  process.argv[2] = 'afk-summary';
  const result = await runAfk(repoRoot);
  process.argv[2] = originalArg;
  assert.equal(result.code, 0);
  assert.match(result.message, /AFK Summary/);
  assert.match(result.message, /completed/);
  assert.match(result.message, /Phase timing highlights/);
  assert.match(result.message, /feat\/01 execution#1: 9000ms/);
  assert.match(result.message, /Pending post-merge cleanup debt\n- none/);
});

test('afk summary subcommand is supported by the single executable entrypoint', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const originalArg = process.argv[2];
  process.argv[2] = 'summary';
  const result = await runAfk(repoRoot);
  process.argv[2] = originalArg;
  assert.equal(result.code, 0);
  assert.match(result.message, /AFK Summary/);
});

test('afk summary shows new status-based sections', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });

  writeFileSync(
    path.join(issuesDir, '01-ready.md'),
    `---
feature: feat
status: ready-for-agent
---
`,
  );

  writeFileSync(
    path.join(issuesDir, '02-wontfix.md'),
    `---
feature: feat
status: wontfix
---
`,
  );

  writeFileSync(
    path.join(issuesDir, '03-legacy.md'),
    `---
feature: feat
---
`,
  );

  writeFileSync(
    path.join(issuesDir, '04-missing.md'),
    `---
feature: feat
status: failed
---
`,
  );

  writeFileSync(
    path.join(issuesDir, '05-completed.md'),
    `---
feature: feat
status: completed
---

## AFK Summary
Timestamp: 2026-05-18T00:00:00.000Z
Outcome: completed
`,
  );

  const originalArg = process.argv[2];
  process.argv[2] = 'afk-summary';
  const result = await runAfk(repoRoot);
  process.argv[2] = originalArg;

  assert.equal(result.code, 0);
  assert.match(result.message, /AFK Summary/);
  assert.match(result.message, /Completed or successful work/);
  assert.match(result.message, /Failed or blocked work/);
  assert.match(result.message, /Interrupted or incomplete work/);
  assert.match(result.message, /Not yet started/);
  assert.match(result.message, /Won't fix/);
  assert.match(result.message, /Legacy \/ malformed/);
  assert.match(result.message, /Missing summaries/);
});

test('afk summary includes pending post-merge cleanup debt details', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-summary-cleanup-debt-'));
  const logsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs');
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    path.join(logsDir, 'pending-post-merge-cleanup.json'),
    JSON.stringify([
      {
        feature: 'feat',
        issueName: '06-cleanup',
        branchName: 'afk/feat/06-cleanup',
        worktreePath: '/tmp/afk-feat-06-cleanup',
        featureWorktreePath: '/tmp/afk-feat',
        featureBranchName: 'afk/feat',
        mergedIssueTip: 'def456',
        warning: 'merge proof failed: branch tip is not reachable from feature HEAD',
        failedAt: '2026-06-11T00:00:00.000Z',
      },
    ]),
    'utf8',
  );

  const originalArg = process.argv[2];
  process.argv[2] = 'afk-summary';
  const result = await runAfk(repoRoot);
  process.argv[2] = originalArg;

  assert.equal(result.code, 0);
  assert.match(result.message, /Pending post-merge cleanup debt/);
  assert.match(result.message, /count: 1/);
  assert.match(result.message, /feat\/06-cleanup/);
  assert.match(result.message, /branch=afk\/feat\/06-cleanup/);
  assert.match(result.message, /worktree=\/tmp\/afk-feat-06-cleanup/);
  assert.match(result.message, /reason=merge proof failed: branch tip is not reachable from feature HEAD/);
});
