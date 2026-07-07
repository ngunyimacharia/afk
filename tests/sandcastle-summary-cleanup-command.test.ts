import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runAfk } from '../src/cli.js';
import { resolveExecutable } from '../src/executable-resolution.js';

const GIT_PATH = resolveExecutable('git');

function git(repoRoot: string, args: string[]): string {
  return execFileSync(GIT_PATH, args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function initRepo(repoRoot: string): void {
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  writeFileSync(path.join(repoRoot, 'README.md'), 'test\n');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-m', 'init']);
}

function writeRun(repoRoot: string, overrides: Record<string, unknown> = {}): string {
  const runDir = path.join(repoRoot, '.scratch', 'sandcastle-runtime', 'runs', 'run-1');
  mkdirSync(runDir, { recursive: true });
  const recordPath = path.join(runDir, 'record.json');
  const record = {
    schemaVersion: 1,
    runId: 'run-1',
    createdAt: '2026-05-18T00:00:00.000Z',
    updatedAt: '2026-05-18T00:00:09.000Z',
    ticket: {
      featureSlug: 'feat',
      issueName: '01',
      label: 'feat/01',
      ticketPath: path.join(repoRoot, '.scratch', 'feat', 'issues', '01.md'),
    },
    trackerSource: 'scratch',
    provider: { provider: 'opencode', model: 'openai/gpt-5.5' },
    sandbox: {
      mode: 'docker',
      image: 'afk-runtime:latest',
      worktreePath: '/workspace/afk-worktree',
      containerName: 'afk-run-1',
    },
    branch: 'afk/feat/01',
    worktreePath: path.join(repoRoot, '.worktree', 'feat-01'),
    phases: [
      {
        phase: 'implementation',
        attempt: 1,
        status: 'passed',
        startedAt: '2026-05-18T00:00:00.000Z',
        completedAt: '2026-05-18T00:00:09.000Z',
        durationMs: 9000,
        commits: [{ sha: 'abc123', subject: 'feat: test' }],
      },
    ],
    commits: [{ sha: 'abc123', subject: 'feat: test' }],
    logs: { run: path.join(runDir, 'run.log'), phases: [] },
    terminal: { status: 'completed', completedAt: '2026-05-18T00:00:09.000Z' },
    cleanupResources: [{ type: 'log', id: 'run-log', path: path.join(runDir, 'run.log') }],
    cleanupResults: [],
    ...overrides,
  };
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return recordPath;
}

test('afk summary reports Sandcastle runtime records and ignores legacy metadata', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-sandcastle-summary-'));
  const legacyMetadataDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata');
  mkdirSync(legacyMetadataDir, { recursive: true });
  writeFileSync(path.join(legacyMetadataDir, 'feat-legacy.json'), 'not json');
  writeRun(repoRoot);

  const originalArgs = [...process.argv];
  process.argv[2] = 'afk-summary';
  const result = await runAfk(repoRoot);
  process.argv = originalArgs;

  assert.equal(result.code, 0);
  assert.match(result.message, /feat\/01/);
  assert.match(result.message, /provider: scratch/);
  assert.match(result.message, /sandbox: docker/);
  assert.match(result.message, /branch: afk\/feat\/01/);
  assert.match(result.message, /worktree: .*feat-01/);
  assert.match(result.message, /terminal: completed/);
  assert.match(result.message, /phases: implementation#1:passed/);
  assert.match(result.message, /commits: abc123/);
  assert.match(result.message, /cleanup: pending/);
});

test('afk cleanup dry-run lists exact Sandcastle cleanup resources without deleting', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-sandcastle-cleanup-dry-'));
  const recordPath = writeRun(repoRoot);
  const runLogPath = path.join(path.dirname(recordPath), 'run.log');
  writeFileSync(runLogPath, 'log\n');

  const originalArgs = [...process.argv];
  process.argv[2] = 'afk-cleanup';
  process.argv[3] = '--dry-run';
  const result = await runAfk(repoRoot);
  process.argv = originalArgs;

  assert.equal(result.code, 0);
  assert.match(result.message, /Sandcastle cleanup resources/);
  assert.match(result.message, new RegExp(`log id=run-log path=${runLogPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(result.message, /Dry run only\. No files were deleted\./);
  assert.equal(existsSync(runLogPath), true);
});

test('afk cleanup confirmed removes only Sandcastle resources and records success', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-sandcastle-cleanup-confirm-'));
  const recordPath = writeRun(repoRoot);
  const runLogPath = path.join(path.dirname(recordPath), 'run.log');
  const legacyLogPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-01.log');
  mkdirSync(path.dirname(legacyLogPath), { recursive: true });
  writeFileSync(runLogPath, 'log\n');
  writeFileSync(legacyLogPath, 'legacy\n');

  const originalArgs = [...process.argv];
  process.argv[2] = 'afk-cleanup';
  const result = await runAfk(repoRoot);
  process.argv = originalArgs;

  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.equal(result.code, 0);
  assert.equal(existsSync(runLogPath), false);
  assert.equal(existsSync(legacyLogPath), true);
  assert.equal(record.cleanupResults[0].status, 'succeeded');
});

test('afk cleanup records safety skips and failures in Sandcastle records', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-sandcastle-cleanup-safety-'));
  initRepo(repoRoot);
  const branchName = 'afk/feat/01';
  git(repoRoot, ['branch', '--no-track', branchName, 'main']);
  const worktreePath = path.join(repoRoot, '.worktree', 'feat-01');
  git(repoRoot, ['worktree', 'add', worktreePath, branchName]);
  writeFileSync(path.join(worktreePath, 'dirty.txt'), 'dirty\n');
  const recordPath = writeRun(repoRoot, {
    branch: branchName,
    worktreePath,
    cleanupResources: [
      { type: 'worktree', id: 'dirty-worktree', path: worktreePath },
      { type: 'branch', id: 'feature/not-afk' },
      { type: 'log', id: 'bad-log', path: path.join(repoRoot, 'outside.log') },
    ],
  });

  const originalArgs = [...process.argv];
  process.argv[2] = 'afk-cleanup';
  const result = await runAfk(repoRoot);
  process.argv = originalArgs;

  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.equal(result.code, 0);
  assert.equal(existsSync(worktreePath), true);
  assert.deepEqual(
    record.cleanupResults.map((item: { status: string }) => item.status),
    ['skipped', 'skipped', 'skipped'],
  );
  assert.match(record.cleanupResults[0].message, /uncommitted changes/);
  assert.match(record.cleanupResults[1].message, /not an AFK branch/);
  assert.match(record.cleanupResults[2].message, /not under Sandcastle runtime root/);
});
