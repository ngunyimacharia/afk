import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SummaryReporter } from '../src/summary-reporter.js';

test('extracts repeated summary blocks and missing summaries', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(path.join(issuesDir, '01.md'), `---
feature: feat
status: ready-for-agent
---

## AFK Summary
Timestamp: 2026-05-18T00:00:00.000Z
Session or run ID: session-1
Outcome: completed
Commits: abc123
Next action: none

## AFK Summary
Timestamp: 2026-05-18T01:00:00.000Z
Outcome: completed

`);
  writeFileSync(path.join(issuesDir, '02.md'), 'Status: ready-for-agent\n');

  const report = await new SummaryReporter({ repoRoot }).summarize();
  assert.match(report.message, /feat\/01/);
  assert.match(report.message, /2 attempts/);
  assert.match(report.message, /Missing summaries/);
  assert.match(report.message, /feat\/02/);
  assert.match(report.message, /feat\/01: 2 attempts/);
});

test('enriches with runtime metadata without raw logs', async () => {
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
Session or run ID: session-1
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
  }, null, 2));

  const report = await new SummaryReporter({ repoRoot }).summarize();
  assert.match(report.message, /runtime: completed/);
  assert.match(report.message, /started: 2026-05-18T00:00:00.000Z/);
  assert.match(report.message, /started: 2026-05-18T00:00:00.000Z/);
});
