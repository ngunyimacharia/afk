import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { BranchMergeLockTimeoutError, withBranchMergeLock } from '../src/branch-merge-lock.js';
import { mkRepoLocalTempDir } from './helpers/temp-repo.js';

function createRepoRoot(): string {
  return mkRepoLocalTempDir('branch-merge-lock-');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('acquires lock, runs callback, and releases', async () => {
  const repoRoot = createRepoRoot();
  const result = await withBranchMergeLock(repoRoot, 'main', async () => 'ok');
  assert.equal(result, 'ok');

  const lockDir = path.join(repoRoot, '.scratch', '.afk-merge-locks', 'main');
  assert.equal(existsSync(lockDir), false);
});

test('sanitizes branch name for filesystem safety', async () => {
  const repoRoot = createRepoRoot();
  await withBranchMergeLock(repoRoot, 'feature/new-thing', async () => {
    const lockDir = path.join(repoRoot, '.scratch', '.afk-merge-locks', 'feature--new-thing');
    assert.equal(existsSync(lockDir), true);
    return 'done';
  });
});

test('two concurrent calls for same branch serialize correctly', async () => {
  const repoRoot = createRepoRoot();
  const order: number[] = [];

  const p1 = withBranchMergeLock(repoRoot, 'main', async () => {
    order.push(1);
    await sleep(100);
    order.push(2);
    return 'first';
  });

  // Small delay so p1 is likely to acquire first, but not required for correctness
  await sleep(10);

  const p2 = withBranchMergeLock(repoRoot, 'main', async () => {
    order.push(3);
    await sleep(50);
    order.push(4);
    return 'second';
  });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 'first');
  assert.equal(r2, 'second');

  // Sequential execution means the pairs (1,2) and (3,4) are not interleaved
  const firstPairIndex = order.indexOf(1) >= 0 ? 0 : 1;
  const secondPairIndex = firstPairIndex === 0 ? 1 : 0;
  assert.equal(order[firstPairIndex * 2 + 1] - order[firstPairIndex * 2], 1);
  assert.equal(order[secondPairIndex * 2 + 1] - order[secondPairIndex * 2], 1);
});

test('detects and removes stale lock from dead process', async () => {
  const repoRoot = createRepoRoot();
  const lockDir = path.join(repoRoot, '.scratch', '.afk-merge-locks', 'main');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(path.join(lockDir, 'pid'), '999999\n', 'utf8');

  const result = await withBranchMergeLock(repoRoot, 'main', async () => 'recovered');
  assert.equal(result, 'recovered');
  assert.equal(existsSync(lockDir), false);
});

test('throws timeout error when lock remains held beyond timeout', async () => {
  const repoRoot = createRepoRoot();
  const lockDir = path.join(repoRoot, '.scratch', '.afk-merge-locks', 'main');
  mkdirSync(lockDir, { recursive: true });
  // Use a different live PID so the lock is considered alive
  writeFileSync(path.join(lockDir, 'pid'), String(process.pid), 'utf8');

  await assert.rejects(
    () => withBranchMergeLock(repoRoot, 'main', async () => 'never', { timeoutMs: 50, pollIntervalMs: 10 }),
    (err: unknown) => err instanceof BranchMergeLockTimeoutError,
  );

  await rm(lockDir, { recursive: true, force: true });
});

test('lock directory is created under .scratch/.afk-merge-locks/', async () => {
  const repoRoot = createRepoRoot();
  await withBranchMergeLock(repoRoot, 'my-branch', async () => {
    const expected = path.join(repoRoot, '.scratch', '.afk-merge-locks', 'my-branch');
    assert.equal(existsSync(expected), true);
    assert.equal(existsSync(path.join(expected, 'pid')), true);
    return 'done';
  });
});
