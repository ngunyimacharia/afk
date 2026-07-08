import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SandcastleRuntimeRecord } from '../src/sandcastle-runtime-store.js';
import { SummaryReporter, TrackerProviderSummaryIssueSource } from '../src/summary-reporter.js';
import type { TrackerProvider, TrackerWorkItem } from '../src/tracker-contract.js';

function writeSandcastleRecord(
  repoRoot: string,
  overrides: Partial<SandcastleRuntimeRecord> & { runId: string; ticket: SandcastleRuntimeRecord['ticket'] },
): void {
  const runDir = path.join(repoRoot, '.scratch', 'sandcastle-runtime', 'runs', overrides.runId);
  mkdirSync(runDir, { recursive: true });
  const record: SandcastleRuntimeRecord = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    trackerSource: 'scratch',
    provider: { provider: 'opencode', model: '' },
    sandbox: { mode: 'none' },
    branch: '',
    worktreePath: '',
    phases: [],
    commits: [],
    logs: { run: '', phases: [] },
    terminal: { status: 'running' },
    providerFailures: [],
    cleanupResources: [],
    cleanupResults: [],
    ...overrides,
  };
  writeFileSync(path.join(runDir, 'record.json'), JSON.stringify(record, null, 2));
}

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

test('enriches with Sandcastle runtime record without raw logs', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
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
  writeSandcastleRecord(repoRoot, {
    runId: 'run-feat-01',
    ticket: {
      featureSlug: 'feat',
      issueName: '01',
      label: 'feat/01',
      ticketPath: path.join(issuesDir, '01.md'),
    },
    terminal: { status: 'completed' },
    createdAt: '2026-05-18T00:00:00.000Z',
  });

  const report = await new SummaryReporter({ repoRoot }).summarize();
  assert.match(report.message, /terminal: completed/);
  assert.match(report.message, /started: 2026-05-18T00:00:00.000Z/);
  assert.doesNotMatch(report.message, /malformed reviewer outputs:/);
  assert.doesNotMatch(report.message, /fixup cycles:/);
  assert.match(report.message, /Phase timing highlights/);
  assert.match(report.message, /- none/);
});

test('reports Docker sandbox mode and container identity from Sandcastle runtime record', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(path.join(issuesDir, '01.md'), '---\nfeature: feat\nstatus: completed\n---\n\n## AFK Summary\nOutcome: completed\n');
  writeSandcastleRecord(repoRoot, {
    runId: 'run-feat-01',
    ticket: {
      featureSlug: 'feat',
      issueName: '01',
      label: 'feat/01',
      ticketPath: path.join(issuesDir, '01.md'),
    },
    sandbox: {
      mode: 'docker',
      image: 'afk-runtime:latest',
      worktreePath: '/workspace',
      containerName: 'afk-runtime-run-feat-01',
    },
    terminal: { status: 'completed' },
  });

  const report = await new SummaryReporter({ repoRoot }).summarize();
  assert.match(report.message, /sandbox: docker/);
  assert.match(report.message, /container: afk-runtime-run-feat-01/);
});


test('reports Docker container id when container name is unavailable', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(path.join(issuesDir, '01.md'), '---\nfeature: feat\nstatus: completed\n---\n\n## AFK Summary\nOutcome: completed\n');
  writeSandcastleRecord(repoRoot, {
    runId: 'run-feat-01',
    ticket: {
      featureSlug: 'feat',
      issueName: '01',
      label: 'feat/01',
      ticketPath: path.join(issuesDir, '01.md'),
    },
    sandbox: {
      mode: 'docker',
      image: 'afk-runtime:latest',
      worktreePath: '/workspace',
      containerId: 'docker-container-id',
    },
    terminal: { status: 'completed' },
  });

  const report = await new SummaryReporter({ repoRoot }).summarize();
  assert.match(report.message, /sandbox: docker/);
  assert.match(report.message, /container: docker-container-id/);
});

test('reports Linear-backed run identity from Sandcastle runtime record', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const mirrorPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'linear-mirrors', 'eng-1-eng-2.md');
  mkdirSync(path.dirname(mirrorPath), { recursive: true });
  writeFileSync(mirrorPath, 'Linear mirror\n');
  writeSandcastleRecord(repoRoot, {
    runId: 'run-eng-1-eng-2',
    trackerSource: 'linear',
    ticket: {
      featureSlug: 'eng-1',
      issueName: 'eng-2',
      label: 'eng-1/eng-2',
      ticketPath: mirrorPath,
      trackerIssueId: 'issue-2',
      trackerIssueKey: 'ENG-2',
      trackerIssueUrl: 'https://linear.app/acme/issue/ENG-2/test',
    },
    terminal: { status: 'completed' },
  });

  const report = await new SummaryReporter({ repoRoot }).summarize();
  assert.match(report.message, /eng-1\/eng-2/);
  assert.match(report.message, /provider: linear/);
  assert.match(report.message, /linear issue: ENG-2/);
  assert.match(report.message, /linear url: https:\/\/linear\.app\/acme\/issue\/ENG-2\/test/);
  assert.match(report.message, new RegExp(`linear mirror: ${mirrorPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('reports timing highlights from Sandcastle phase history', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });

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

  writeSandcastleRecord(repoRoot, {
    runId: 'run-feat-01',
    ticket: {
      featureSlug: 'feat',
      issueName: '01',
      label: 'feat/01',
      ticketPath: path.join(issuesDir, '01.md'),
    },
    terminal: { status: 'blocked' },
    phases: [
      {
        phase: 'implementation',
        attempt: 1,
        status: 'passed',
        startedAt: '2026-05-18T00:00:00.000Z',
        completedAt: '2026-05-18T00:00:10.000Z',
        durationMs: 10000,
      },
      {
        phase: 'review',
        attempt: 1,
        status: 'passed',
        startedAt: '2026-05-18T00:00:11.000Z',
        completedAt: '2026-05-18T00:00:25.000Z',
        durationMs: 14000,
      },
      {
        phase: 'fixup',
        attempt: 1,
        status: 'passed',
        startedAt: '2026-05-18T00:00:26.000Z',
        completedAt: '2026-05-18T00:00:40.000Z',
        durationMs: 14000,
      },
      {
        phase: 'fixup',
        attempt: 2,
        status: 'passed',
        startedAt: '2026-05-18T00:00:41.000Z',
        completedAt: '2026-05-18T00:01:03.000Z',
        durationMs: 22000,
      },
    ],
  });

  const report = await new SummaryReporter({ repoRoot }).summarize();
  assert.match(report.message, /Overall slowest phases/);
  assert.match(report.message, /feat\/01 fixup#2: 22000ms/);
  assert.match(report.message, /Slowest by phase category/);
  assert.match(report.message, /fixup: feat\/01#2 \(22000ms\)/);
  assert.match(report.message, /Terminal state totals/);
  assert.match(report.message, /blocked: 1 run, 60000ms/);
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

test('reports handoff state from Sandcastle runtime record', async () => {
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
Outcome: handoff
`,
  );

  writeSandcastleRecord(repoRoot, {
    runId: 'run-feat-01',
    ticket: {
      featureSlug: 'feat',
      issueName: '01',
      label: 'feat/01',
      ticketPath: path.join(issuesDir, '01.md'),
    },
    terminal: { status: 'handoff', handoffReason: 'awaiting manual review' },
  });

  const report = await new SummaryReporter({ repoRoot }).summarize();
  assert.match(report.message, /Handoff or manual review[\s\S]*feat\/01/);
  assert.match(report.message, /terminal: handoff/);
  assert.match(report.message, /handoff reason: awaiting manual review/);
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

test('reports leftover cleanup counts from Sandcastle runtime records', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  writeSandcastleRecord(repoRoot, {
    runId: 'run-feat-01',
    ticket: {
      featureSlug: 'feat',
      issueName: '01',
      label: 'feat/01',
      ticketPath: path.join(repoRoot, '.scratch', 'feat', 'issues', '01.md'),
    },
    terminal: { status: 'blocked' },
  });

  const report = await new SummaryReporter({ repoRoot }).summarize();
  assert.match(report.message, /Leftover cleanup counts/);
  assert.match(report.message, /leftover branches: 0/);
  assert.match(report.message, /leftover worktrees: 0/);
});

test('can read summaries through a provider-backed source', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const provider = makeSummaryProvider([
    {
      key: { provider: 'linear', id: 'LIN-1' },
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
      providerRef: { key: { provider: 'linear', id: 'LIN-1' }, url: 'https://linear.example/LIN-1' },
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

test('counts leftover worktrees excluding active runtime worktree paths', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const worktreeRoot = path.join(repoRoot, '.worktree');
  mkdirSync(path.join(worktreeRoot, 'active-run'), { recursive: true });
  mkdirSync(path.join(worktreeRoot, 'orphan'), { recursive: true });

  writeSandcastleRecord(repoRoot, {
    runId: 'run-feat-01',
    ticket: {
      featureSlug: 'feat',
      issueName: '01',
      label: 'feat/01',
      ticketPath: path.join(repoRoot, '.scratch', 'feat', 'issues', '01.md'),
    },
    terminal: { status: 'running' },
    worktreePath: path.join(worktreeRoot, 'active-run'),
  });

  const report = await new SummaryReporter({ repoRoot }).summarize();
  assert.match(report.message, /Leftover cleanup counts/);
  assert.match(report.message, /leftover worktrees: 1/);
  assert.match(report.message, /leftover branches: 0/);
});

function makeSummaryProvider(items: TrackerWorkItem[]): TrackerProvider {
  return {
    kind: 'linear',
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
