import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SummaryReporter } from '../src/summary-reporter.js';

test('extracts repeated summary blocks and missing summaries', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(
    path.join(issuesDir, '01.md'),
    `---
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

`,
  );
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
  writeFileSync(
    path.join(issuesDir, '01.md'),
    `---
feature: feat
status: completed
---

## AFK Summary
Timestamp: 2026-05-18T00:00:00.000Z
Session or run ID: session-1
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
      },
      null,
      2,
    ),
  );

  const report = await new SummaryReporter({ repoRoot }).summarize();
  assert.match(report.message, /runtime: completed/);
  assert.match(report.message, /started: 2026-05-18T00:00:00.000Z/);
  assert.doesNotMatch(report.message, /malformed reviewer outputs:/);
  assert.doesNotMatch(report.message, /fixup cycles:/);
  assert.match(report.message, /Phase timing highlights/);
  assert.match(report.message, /- none/);
});

test('reports timing and review counters from metadata when available', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  const metadataDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata');
  mkdirSync(issuesDir, { recursive: true });
  mkdirSync(metadataDir, { recursive: true });

  writeFileSync(
    path.join(issuesDir, '01.md'),
    `---
feature: feat
status: blocked
---

## AFK Summary
Timestamp: 2026-05-18T00:00:00.000Z
Outcome: blocked
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
        STATUS: 'blocked',
        EXECUTION_PROVIDER: 'opencode',
        PROVIDER_SESSION_ID: 'session-1',
        PROVIDER_SESSION_REMOVABLE: true,
        INSPECTION_PROVIDER: null,
        INSPECTION_TARGET_IDENTIFIER: null,
        FAILURE_KIND: 'needs-human',
        UNSAFE_REASON: 'budget exceeded: fixup-cycle-cap',
        REVIEW_CYCLE_HISTORY: [
          { cycle: 1, outcome: 'loop-required', reason: 'missing tests', malformed: true, findings: [] },
          { cycle: 2, outcome: 'loop-required', reason: 'cleanup needed', malformed: false, findings: [] },
        ],
        PHASE_HISTORY: [
          {
            name: 'execution',
            startTime: '2026-05-18T00:00:00.000Z',
            endTime: '2026-05-18T00:00:10.000Z',
            durationMs: 10000,
            cycle: 1,
          },
          {
            name: 'review',
            startTime: '2026-05-18T00:00:11.000Z',
            endTime: '2026-05-18T00:00:25.000Z',
            durationMs: 14000,
            cycle: 1,
          },
          {
            name: 'fixup',
            startTime: '2026-05-18T00:00:26.000Z',
            endTime: '2026-05-18T00:00:40.000Z',
            durationMs: 14000,
            cycle: 1,
          },
          {
            name: 'fixup',
            startTime: '2026-05-18T00:00:41.000Z',
            endTime: '2026-05-18T00:01:03.000Z',
            durationMs: 22000,
            cycle: 2,
          },
        ],
      },
      null,
      2,
    ),
  );

  const report = await new SummaryReporter({ repoRoot }).summarize();
  assert.match(report.message, /review cycles: 2/);
  assert.match(report.message, /malformed reviewer outputs: 1/);
  assert.match(report.message, /fixup cycles: 2/);
  assert.match(report.message, /failure kind: needs-human/);
  assert.match(report.message, /readiness blocker: needs-human/);
  assert.match(report.message, /Overall slowest phases/);
  assert.match(report.message, /feat\/01 fixup#2: 22000ms/);
  assert.match(report.message, /Slowest by phase category/);
  assert.match(report.message, /fixup: feat\/01#2 \(22000ms\)/);
  assert.match(report.message, /Failure kind totals/);
  assert.match(report.message, /needs-human: 1 run, 60000ms/);
});

test('detects AFK summary when it is the last section in file', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });

  writeFileSync(
    path.join(issuesDir, '01.md'),
    `---
feature: feat
status: done
---

## AFK Summary
Timestamp: 2026-05-21T16:00:00.000Z
Outcome: completed`,
  );

  const report = await new SummaryReporter({ repoRoot }).summarize();
  assert.doesNotMatch(report.message, /Missing summaries\n- feat\/01/);
  assert.match(report.message, /Completed or successful work[\s\S]*feat\/01/);
});
