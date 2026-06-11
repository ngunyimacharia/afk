import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readRunPlan, runAfk, writeRunPlan } from '../src/cli.js';

function writeMinimalAfkConfig(repoRoot: string): void {
  writeFileSync(path.join(repoRoot, 'afk.json'), JSON.stringify({ testsEnabled: false, staticCheckCommands: [] }));
}

test('afk tui errors when no active run exists', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-tui-no-run-'));
  writeMinimalAfkConfig(repoRoot);
  const originalArg = process.argv[2];
  process.argv[2] = 'tui';
  const result = await runAfk(repoRoot, {
    io: { stdin: { isTTY: false } as never, stdout: { isTTY: false } as never },
  });
  process.argv[2] = originalArg;
  assert.equal(result.code, 1);
  assert.match(result.message, /No active run/);
});

test('afk tui attaches to an active run', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-tui-attach-'));
  writeMinimalAfkConfig(repoRoot);
  const logsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs');
  mkdirSync(logsDir, { recursive: true });
  const now = Date.now();
  writeFileSync(
    path.join(logsDir, 'active-run.json'),
    `${JSON.stringify({
      version: 1,
      runId: 'existing-run',
      pid: process.pid,
      startedAt: new Date(now - 10_000).toISOString(),
      heartbeatAt: new Date(now - 1_000).toISOString(),
      state: 'running',
      command: 'afk',
    })}
`,
    'utf8',
  );

  const originalArg = process.argv[2];
  process.argv[2] = 'tui';
  const result = await runAfk(repoRoot, {
    io: { stdin: { isTTY: false } as never, stdout: { isTTY: false } as never },
  });
  process.argv[2] = originalArg;
  assert.equal(result.code, 0);
  assert.match(result.message, /Attached to active run/);
  assert.match(result.message, /existing-run/);
});

test('afk tui attaches to an active run with run plan tickets', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-tui-plan-'));
  writeMinimalAfkConfig(repoRoot);
  const logsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs');
  mkdirSync(logsDir, { recursive: true });
  const now = Date.now();
  const runId = 'plan-run-123';
  writeFileSync(
    path.join(logsDir, 'active-run.json'),
    `${JSON.stringify({
      version: 1,
      runId,
      pid: process.pid,
      startedAt: new Date(now - 10_000).toISOString(),
      heartbeatAt: new Date(now - 1_000).toISOString(),
      state: 'running',
      command: 'afk',
    })}
`,
    'utf8',
  );

  const tickets = [
    {
      path: '/tmp/feat/ticket1.md',
      feature: 'feat',
      issueName: 'ticket1',
      label: 'feat/ticket1',
      status: 'in-progress',
      executorAfk: true,
    },
    {
      path: '/tmp/feat/ticket2.md',
      feature: 'feat',
      issueName: 'ticket2',
      label: 'feat/ticket2',
      status: 'in-progress',
      executorAfk: true,
    },
  ];
  writeRunPlan(repoRoot, runId, tickets);

  const originalArg = process.argv[2];
  process.argv[2] = 'tui';
  const result = await runAfk(repoRoot, {
    io: { stdin: { isTTY: false } as never, stdout: { isTTY: false } as never },
  });
  process.argv[2] = originalArg;
  assert.equal(result.code, 0);
  assert.match(result.message, /Attached to active run/);
  assert.match(result.message, new RegExp(runId));
});

test('afk stop with no active run prints error and exits 1', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-stop-no-run-'));
  const originalArg = process.argv[2];
  process.argv[2] = 'stop';
  const result = await runAfk(repoRoot);
  process.argv[2] = originalArg;
  assert.equal(result.code, 1);
  assert.match(result.message, /No active AFK run/);
});

test('afk stop signals active run and blocks until it exits', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-stop-success-'));
  const logsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs');
  mkdirSync(logsDir, { recursive: true });
  const now = Date.now();
  writeFileSync(
    path.join(logsDir, 'active-run.json'),
    `${JSON.stringify({
      version: 1,
      runId: 'stop-run-123',
      pid: process.pid,
      startedAt: new Date(now - 10_000).toISOString(),
      heartbeatAt: new Date(now - 1_000).toISOString(),
      state: 'running',
      command: 'afk',
    })}
`,
    'utf8',
  );

  // Simulate the daemon clearing the run record shortly after kill is sent
  setTimeout(() => {
    try {
      const activeRunPath = path.join(logsDir, 'active-run.json');
      if (existsSync(activeRunPath)) {
        rmSync(activeRunPath);
      }
    } catch {
      // ignore
    }
  }, 100);

  const originalArg = process.argv[2];
  process.argv[2] = 'stop';
  const result = await runAfk(repoRoot, { stopTimeoutMs: 2_000, stopPollIntervalMs: 50 });
  process.argv[2] = originalArg;
  assert.equal(result.code, 0);
  assert.match(result.message, /Stopped AFK run stop-run-123/);
});

test('afk stop times out if daemon does not exit', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-stop-timeout-'));
  const logsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs');
  mkdirSync(logsDir, { recursive: true });
  const now = Date.now();
  writeFileSync(
    path.join(logsDir, 'active-run.json'),
    `${JSON.stringify({
      version: 1,
      runId: 'stop-run-456',
      pid: process.pid,
      startedAt: new Date(now - 10_000).toISOString(),
      heartbeatAt: new Date(now - 1_000).toISOString(),
      state: 'running',
      command: 'afk',
    })}
`,
    'utf8',
  );

  const originalArg = process.argv[2];
  process.argv[2] = 'stop';
  const result = await runAfk(repoRoot, { stopTimeoutMs: 150, stopPollIntervalMs: 50 });
  process.argv[2] = originalArg;
  assert.equal(result.code, 1);
  assert.match(result.message, /Timeout: AFK run stop-run-456 did not stop within 0\.15s/);
});

test('afk status prints no active run when no run exists', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-status-no-run-'));
  writeMinimalAfkConfig(repoRoot);
  const originalArg = process.argv[2];
  process.argv[2] = 'status';
  const result = await runAfk(repoRoot);
  process.argv[2] = originalArg;
  assert.equal(result.code, 0);
  assert.match(result.message, /No active AFK run/);
});

test('afk status shows pending post-merge cleanup debt count', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-status-cleanup-debt-'));
  writeMinimalAfkConfig(repoRoot);
  const logsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs');
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    path.join(logsDir, 'pending-post-merge-cleanup.json'),
    JSON.stringify([
      {
        feature: 'feat',
        issueName: '01',
        branchName: 'afk/feat/01',
        worktreePath: '/tmp/afk-feat-01',
        featureWorktreePath: '/tmp/afk-feat',
        featureBranchName: 'afk/feat',
        mergedIssueTip: 'abc123',
        warning: 'merge proof failed: branch tip is not reachable from feature HEAD',
        failedAt: '2026-06-11T00:00:00.000Z',
      },
    ]),
    'utf8',
  );

  const originalArg = process.argv[2];
  process.argv[2] = 'status';
  const result = await runAfk(repoRoot);
  process.argv[2] = originalArg;
  assert.equal(result.code, 0);
  assert.match(result.message, /No active AFK run/);
  assert.match(result.message, /Pending post-merge cleanup debt:\s+1/);
});

test('afk status prints run details for an active run', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-status-active-'));
  writeMinimalAfkConfig(repoRoot);
  const logsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs');
  mkdirSync(logsDir, { recursive: true });
  const now = Date.now();
  writeFileSync(
    path.join(logsDir, 'active-run.json'),
    `${JSON.stringify({
      version: 1,
      runId: 'test-run-123',
      pid: process.pid,
      startedAt: new Date(now - 60_000).toISOString(),
      heartbeatAt: new Date(now - 2_000).toISOString(),
      state: 'running',
      command: 'afk',
    })}
`,
    'utf8',
  );

  const originalArg = process.argv[2];
  process.argv[2] = 'status';
  const result = await runAfk(repoRoot);
  process.argv[2] = originalArg;
  assert.equal(result.code, 0);
  assert.match(result.message, /Run ID:\s+test-run-123/);
  assert.match(result.message, /State:\s+running/);
  assert.match(result.message, /PID:\s+\d+/);
  assert.match(result.message, /Started:/);
  assert.match(result.message, /Heartbeat:/);
});

test('afk status includes model, harness, and ticket count from runtime metadata', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-status-metadata-'));
  writeMinimalAfkConfig(repoRoot);
  const logsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs');
  const metadataDir = path.join(logsDir, 'runtime-metadata');
  mkdirSync(metadataDir, { recursive: true });
  const now = Date.now();
  writeFileSync(
    path.join(logsDir, 'active-run.json'),
    `${JSON.stringify({
      version: 1,
      runId: 'meta-run-456',
      pid: process.pid,
      startedAt: new Date(now - 120_000).toISOString(),
      heartbeatAt: new Date(now - 5_000).toISOString(),
      state: 'running',
      command: 'afk',
    })}
`,
    'utf8',
  );
  writeFileSync(
    path.join(metadataDir, 'feat-ticket1.json'),
    JSON.stringify({
      RUN_ID: 'meta-run-456',
      EXECUTION_MODEL_ID: 'claude-sonnet-4',
      EXECUTION_PROVIDER: 'opencode',
      TICKET_PATH: '/tmp/t1.md',
      FEATURE_SLUG: 'feat',
      ISSUE_NAME: 'ticket1',
      LOG_PATH: '/tmp/t1.log',
      START_TIME: new Date(now).toISOString(),
      START_EPOCH: now,
      DONE_SENTINEL_PATH: '/tmp/t1.done',
      FAILED_SENTINEL_PATH: '/tmp/t1.failed',
      STATUS: 'running',
      PROVIDER_SESSION_ID: null,
      PROVIDER_SESSION_REMOVABLE: false,
      INSPECTION_PROVIDER: null,
      INSPECTION_TARGET_IDENTIFIER: null,
      UNSAFE_REASON: 'session capture pending',
    }),
    'utf8',
  );
  writeFileSync(
    path.join(metadataDir, 'feat-ticket2.json'),
    JSON.stringify({
      RUN_ID: 'meta-run-456',
      EXECUTION_MODEL_ID: 'claude-sonnet-4',
      EXECUTION_PROVIDER: 'opencode',
      TICKET_PATH: '/tmp/t2.md',
      FEATURE_SLUG: 'feat',
      ISSUE_NAME: 'ticket2',
      LOG_PATH: '/tmp/t2.log',
      START_TIME: new Date(now).toISOString(),
      START_EPOCH: now,
      DONE_SENTINEL_PATH: '/tmp/t2.done',
      FAILED_SENTINEL_PATH: '/tmp/t2.failed',
      STATUS: 'running',
      PROVIDER_SESSION_ID: null,
      PROVIDER_SESSION_REMOVABLE: false,
      INSPECTION_PROVIDER: null,
      INSPECTION_TARGET_IDENTIFIER: null,
      UNSAFE_REASON: 'session capture pending',
    }),
    'utf8',
  );

  const originalArg = process.argv[2];
  process.argv[2] = 'status';
  const result = await runAfk(repoRoot);
  process.argv[2] = originalArg;
  assert.equal(result.code, 0);
  assert.match(result.message, /Run ID:\s+meta-run-456/);
  assert.match(result.message, /Model:\s+claude-sonnet-4/);
  assert.match(result.message, /Harness:\s+OpenCode/);
  assert.match(result.message, /Tickets:\s+2/);
});

test('writeRunPlan round-trips tickets through readRunPlan', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-run-plan-roundtrip-'));
  const tickets = [
    {
      path: '/tmp/feat/ticket1.md',
      feature: 'feat',
      issueName: 'ticket1',
      label: 'feat/ticket1',
      status: 'in-progress',
      executorAfk: true,
      dependsOn: ['ticket0'],
    },
    {
      path: '/tmp/feat/ticket2.md',
      feature: 'feat',
      issueName: 'ticket2',
      label: 'feat/ticket2',
      executorAfk: false,
    },
  ];
  writeRunPlan(repoRoot, 'run-123', tickets);
  const read = readRunPlan(repoRoot, 'run-123');
  assert.ok(read);
  assert.equal(read.length, 2);
  assert.deepStrictEqual(read[0], tickets[0]);
  assert.deepStrictEqual(read[1], tickets[1]);
});

test('readRunPlan returns null for missing plan file', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-run-plan-missing-'));
  const read = readRunPlan(repoRoot, 'nonexistent-run');
  assert.equal(read, null);
});
