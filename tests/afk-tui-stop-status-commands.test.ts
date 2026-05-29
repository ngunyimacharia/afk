import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runAfk } from '../src/cli.js';

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

test('afk stop prints not yet implemented', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-stop-'));
  const originalArg = process.argv[2];
  process.argv[2] = 'stop';
  const result = await runAfk(repoRoot);
  process.argv[2] = originalArg;
  assert.equal(result.code, 0);
  assert.match(result.message, /Not yet implemented/);
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
