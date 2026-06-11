import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getDaemonSpawnCommand, runAfk } from '../src/cli.js';
import { buildLaunchPlan } from '../src/launch-context-builder.js';

function writeMinimalAfkConfig(repoRoot: string): void {
  writeFileSync(path.join(repoRoot, 'afk.json'), JSON.stringify({ testsEnabled: false, staticCheckCommands: [] }));
}

test('__daemon command runs scheduler from context file', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-daemon-cmd-'));
  writeMinimalAfkConfig(repoRoot);
  const contextPath = path.join(repoRoot, 'daemon-context.json');

  const plan = buildLaunchPlan(
    repoRoot,
    { id: 'test-model' },
    [],
    {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: repoRoot,
    },
    {
      harness: 'OpenCode',
      model: { id: 'reviewer-model' },
      prompt: { id: 'reviewer-default', label: 'Default', path: '/tmp/reviewer.md' },
    },
  );

  const context = {
    repoRoot,
    runId: 'daemon-run-1',
    plan,
    harness: 'OpenCode' as const,
    reviewerHarness: 'OpenCode' as const,
    concurrency: 1,
  };

  writeFileSync(contextPath, JSON.stringify(context), 'utf8');

  const originalArg = process.argv[2];
  process.argv[2] = '__daemon';
  const originalArg3 = process.argv[3];
  process.argv[3] = contextPath;

  const result = await runAfk(repoRoot);

  process.argv[2] = originalArg;
  process.argv[3] = originalArg3;

  assert.equal(result.code, 0);
  assert.equal(result.message, '');

  // Verify active run was cleared (empty plan completes immediately)
  const activeRunPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'active-run.json');
  assert.equal(existsSync(activeRunPath), false);

  // Verify context file was cleaned up
  assert.equal(existsSync(contextPath), false);
});

test('__daemon command clears active run on empty plan', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-daemon-empty-'));
  writeMinimalAfkConfig(repoRoot);
  const contextPath = path.join(repoRoot, 'daemon-context.json');

  const plan = buildLaunchPlan(repoRoot, { id: 'test-model' }, [], {
    featureSlug: 'feat',
    defaultWorktreeName: 'feat',
    effectiveWorktreeName: 'feat',
    defaultBranchName: 'feat',
    effectiveBranchName: 'feat',
    worktreePath: repoRoot,
  });

  const context = {
    repoRoot,
    runId: 'daemon-run-2',
    plan,
    harness: 'OpenCode' as const,
    reviewerHarness: 'OpenCode' as const,
    concurrency: 1,
  };

  writeFileSync(contextPath, JSON.stringify(context), 'utf8');

  const originalArg = process.argv[2];
  process.argv[2] = '__daemon';
  const originalArg3 = process.argv[3];
  process.argv[3] = contextPath;

  const result = await runAfk(repoRoot);

  process.argv[2] = originalArg;
  process.argv[3] = originalArg3;

  assert.equal(result.code, 0);
  const activeRunPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'active-run.json');
  assert.equal(existsSync(activeRunPath), false);

  // Verify context file was cleaned up
  assert.equal(existsSync(contextPath), false);
});

test('__daemon command accepts Codex implementation and reviewer context', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-daemon-codex-'));
  writeMinimalAfkConfig(repoRoot);
  const contextPath = path.join(repoRoot, 'daemon-context.json');

  const plan = buildLaunchPlan(
    repoRoot,
    { id: 'codex/default' },
    [],
    {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: repoRoot,
    },
    {
      harness: 'Codex',
      model: { id: 'codex/default' },
      prompt: { id: 'reviewer-default', label: 'Default', path: '/tmp/reviewer.md' },
    },
    undefined,
    undefined,
    'Codex',
  );

  const context = {
    repoRoot,
    runId: 'daemon-run-codex',
    plan,
    harness: 'Codex' as const,
    reviewerHarness: 'Codex' as const,
    concurrency: 1,
  };

  writeFileSync(contextPath, JSON.stringify(context), 'utf8');

  const originalArg = process.argv[2];
  process.argv[2] = '__daemon';
  const originalArg3 = process.argv[3];
  process.argv[3] = contextPath;

  const result = await runAfk(repoRoot);

  process.argv[2] = originalArg;
  process.argv[3] = originalArg3;

  assert.equal(result.code, 0);
  assert.equal(existsSync(contextPath), false);
});

test('__daemon command in argv[1] works for compiled mode', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-daemon-compiled-'));
  writeMinimalAfkConfig(repoRoot);
  const contextPath = path.join(repoRoot, 'daemon-context.json');

  const plan = buildLaunchPlan(
    repoRoot,
    { id: 'test-model' },
    [],
    {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: repoRoot,
    },
    {
      harness: 'OpenCode',
      model: { id: 'reviewer-model' },
      prompt: { id: 'reviewer-default', label: 'Default', path: '/tmp/reviewer.md' },
    },
  );

  const context = {
    repoRoot,
    runId: 'daemon-run-compiled',
    plan,
    harness: 'OpenCode' as const,
    reviewerHarness: 'OpenCode' as const,
    concurrency: 1,
  };

  writeFileSync(contextPath, JSON.stringify(context), 'utf8');

  const originalArg1 = process.argv[1];
  process.argv[1] = '__daemon';
  const originalArg2 = process.argv[2];
  process.argv[2] = contextPath;

  const result = await runAfk(repoRoot);

  process.argv[1] = originalArg1;
  process.argv[2] = originalArg2;

  assert.equal(result.code, 0);
  assert.equal(result.message, '');

  // Verify context file was cleaned up
  assert.equal(existsSync(contextPath), false);
});

test('__daemon command errors when context path is missing', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-daemon-no-context-'));
  writeMinimalAfkConfig(repoRoot);

  const originalArg = process.argv[2];
  process.argv[2] = '__daemon';
  const originalArg3 = process.argv[3];
  process.argv[3] = '';

  const result = await runAfk(repoRoot);

  process.argv[2] = originalArg;
  process.argv[3] = originalArg3;

  assert.equal(result.code, 1);
  assert.match(result.message, /Daemon context path required/);
});

test('compiled daemon spawn uses binary argv instead of bun execPath', () => {
  const originalArgv = [...process.argv];
  const originalExecPath = process.execPath;
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-daemon-self-'));
  const binaryPath = path.join(repoRoot, 'afk');
  writeFileSync(binaryPath, '');
  chmodSync(binaryPath, 0o755);

  try {
    Object.defineProperty(process, 'execPath', { value: '/opt/homebrew/bin/bun', configurable: true });
    process.argv = ['/opt/homebrew/bin/bun', binaryPath];

    const command = getDaemonSpawnCommand('/tmp/context.json');

    assert.deepEqual(command, {
      command: binaryPath,
      args: ['__daemon', '/tmp/context.json'],
    });
  } finally {
    process.argv = originalArgv;
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  }
});

test('compiled daemon spawn skips bun virtual filesystem path', () => {
  const originalArgv = [...process.argv];
  const originalExecPath = process.execPath;

  try {
    Object.defineProperty(process, 'execPath', { value: '/opt/homebrew/bin/bun', configurable: true });
    process.argv = ['/opt/homebrew/bin/bun', '/$bunfs/root/afk'];

    const command = getDaemonSpawnCommand('/tmp/context.json');

    assert.deepEqual(command, {
      command: '/opt/homebrew/bin/afk',
      args: ['__daemon', '/tmp/context.json'],
    });
  } finally {
    process.argv = originalArgv;
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
  }
});
