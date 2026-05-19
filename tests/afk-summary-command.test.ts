import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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
  writeFileSync(path.join(issuesDir, '01.md'), `---
feature: feat
status: completed
---

## AFK Summary
Timestamp: 2026-05-18T00:00:00.000Z
Outcome: completed
`);
  writeFileSync(path.join(metadataDir, 'feat-01.json'), JSON.stringify({
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
      { name: 'execution', startTime: '2026-05-18T00:00:00.000Z', endTime: '2026-05-18T00:00:09.000Z', durationMs: 9000, cycle: 1 },
    ],
  }, null, 2));
  const originalArg = process.argv[2];
  process.argv[2] = 'afk-summary';
  const result = await runAfk(repoRoot);
  process.argv[2] = originalArg;
  assert.equal(result.code, 0);
  assert.match(result.message, /AFK Summary/);
  assert.match(result.message, /completed/);
  assert.match(result.message, /Phase timing highlights/);
  assert.match(result.message, /feat\/01 execution#1: 9000ms/);
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
