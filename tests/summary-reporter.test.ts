import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SummaryReporter, TrackerProviderSummaryIssueSource } from '../src/summary-reporter.js';
import type { TrackerProvider, TrackerWorkItem } from '../src/tracker-contract.js';

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
  assert.match(report.message, /Legacy \/ malformed[\s\S]*feat\/02/);
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

test('reports handoff state from runtime metadata', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  const metadataDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata');
  mkdirSync(issuesDir, { recursive: true });
  mkdirSync(metadataDir, { recursive: true });

  writeFileSync(
    path.join(issuesDir, '01.md'),
    `---
feature: feat
status: ready-for-agent
---

## AFK Summary
Timestamp: 2026-05-18T00:00:00.000Z
Outcome: handoff
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
        IMPLEMENTATION_STATUS: 'completed',
        REVIEW_STATUS: 'unavailable',
        RUN_STATUS: 'handoff',
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
  assert.match(report.message, /Handoff or manual review[\s\S]*feat\/01/);
  assert.match(report.message, /run: handoff/);
  assert.match(report.message, /implementation: completed/);
  assert.match(report.message, /review: unavailable/);
  assert.doesNotMatch(report.message, /Failed or blocked work[\s\S]*feat\/01/);
});

test('ready-for-agent ticket without summary appears in Not yet started', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(
    path.join(issuesDir, '01.md'),
    `---
feature: feat
status: ready-for-agent
---
`,
  );
  const report = await new SummaryReporter({ repoRoot }).summarize();
  assert.match(report.message, /Not yet started[\s\S]*feat\/01/);
  assert.doesNotMatch(report.message, /Missing summaries[\s\S]*feat\/01/);
});

test('wontfix ticket without summary appears in Will not fix', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(
    path.join(issuesDir, '01.md'),
    `---
feature: feat
status: wontfix
---
`,
  );
  const report = await new SummaryReporter({ repoRoot }).summarize();
  assert.match(report.message, /Won't fix[\s\S]*feat\/01/);
  assert.doesNotMatch(report.message, /Missing summaries[\s\S]*feat\/01/);
});

test('ticket with no status and no summary appears in Legacy / malformed', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(path.join(issuesDir, '01.md'), '');
  const report = await new SummaryReporter({ repoRoot }).summarize();
  assert.match(report.message, /Legacy \/ malformed[\s\S]*feat\/01/);
  assert.doesNotMatch(report.message, /Missing summaries[\s\S]*feat\/01/);
});

test('blocked ticket without summary appears in Missing summaries', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(
    path.join(issuesDir, '01.md'),
    `---
feature: feat
status: blocked
---
`,
  );
  const report = await new SummaryReporter({ repoRoot }).summarize();
  assert.match(report.message, /Missing summaries[\s\S]*feat\/01/);
});

test('ticket with summary and ready-for-agent status is classified by summary content', async () => {
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
Outcome: completed
`,
  );
  const report = await new SummaryReporter({ repoRoot }).summarize();
  assert.match(report.message, /Completed or successful work[\s\S]*feat\/01/);
  assert.doesNotMatch(report.message, /Not yet started[\s\S]*feat\/01/);
});

test('can read summaries through a provider-backed source', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const provider = makeSummaryProvider([
    {
      key: { provider: 'linear-graphql', id: 'LIN-1' },
      feature: 'feat',
      issueName: '01',
      label: 'feat/01',
      status: 'done',
      executorAfk: true,
      dependsOn: [],
      title: 'Provider issue',
      body: `## AFK Summary
Timestamp: 2026-05-18T00:00:00.000Z
Outcome: completed
`,
      providerRef: { key: { provider: 'linear-graphql', id: 'LIN-1' }, url: 'https://linear.example/LIN-1' },
      url: 'https://linear.example/LIN-1',
    },
  ]);

  const report = await new SummaryReporter({
    repoRoot,
    source: new TrackerProviderSummaryIssueSource(provider),
  }).summarize();

  assert.match(report.message, /Completed or successful work[\s\S]*feat\/01/);
  assert.doesNotMatch(report.message, /Missing summaries[\s\S]*feat\/01/);
});

function makeSummaryProvider(items: TrackerWorkItem[]): TrackerProvider {
  return {
    kind: 'linear-graphql',
    capabilities: {
      list: true,
      get: true,
      create: false,
      update: false,
      appendComment: false,
      materialize: false,
      applyRunResult: false,
      summarize: true,
      cleanupIssues: false,
      parentChildIssues: true,
    },
    async list() {
      return items;
    },
    isEligible() {
      return true;
    },
    async get(key) {
      return items.find((item) => item.key.provider === key.provider && item.key.id === key.id) ?? null;
    },
    async create() {
      throw new Error('not implemented');
    },
    async update() {
      throw new Error('not implemented');
    },
    async appendComment() {
      throw new Error('not implemented');
    },
    async materialize() {
      throw new Error('not implemented');
    },
    async applyRunResult() {
      throw new Error('not implemented');
    },
  };
}
