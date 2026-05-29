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

test('afk status prints not yet implemented', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-status-'));
  const originalArg = process.argv[2];
  process.argv[2] = 'status';
  const result = await runAfk(repoRoot);
  process.argv[2] = originalArg;
  assert.equal(result.code, 0);
  assert.match(result.message, /Not yet implemented/);
});
