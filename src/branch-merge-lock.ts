import { rmSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface BranchMergeLockOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export class BranchMergeLockTimeoutError extends Error {
  constructor(branchName: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting to acquire merge lock for branch "${branchName}"`);
    this.name = 'BranchMergeLockTimeoutError';
  }
}

const heldLockCounts = new Map<string, number>();

process.on('exit', () => {
  for (const [lockDir, count] of heldLockCounts) {
    if (count > 0) {
      try {
        rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup on process exit
      }
    }
  }
});

function getLockDir(repoRoot: string, branchName: string): string {
  return path.join(repoRoot, '.scratch', '.afk-merge-locks', sanitizeBranchName(branchName));
}

function sanitizeBranchName(branchName: string): string {
  return branchName
    .replace(/\//g, '--')
    .replace(/[\\:*?"<>|]/g, '_')
    .replace(/^\.+/, '_');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ensureLockParentDirs(repoRoot: string): Promise<void> {
  const parent = path.join(repoRoot, '.scratch', '.afk-merge-locks');
  await mkdir(parent, { recursive: true });
}

async function tryAcquireLock(lockDir: string): Promise<boolean> {
  try {
    await mkdir(lockDir, { recursive: false });
    await writeFile(path.join(lockDir, 'pid'), String(process.pid), { encoding: 'utf8' });
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

async function isStaleLock(lockDir: string): Promise<boolean> {
  try {
    const pidText = await readFile(path.join(lockDir, 'pid'), { encoding: 'utf8' });
    const pid = Number(pidText.trim());
    if (!Number.isFinite(pid) || pid <= 0) {
      return true;
    }
    if (pid === process.pid) {
      return false;
    }
    return !isProcessAlive(pid);
  } catch {
    // If we can't read the pid file, assume stale
    return true;
  }
}

async function removeStaleLock(lockDir: string): Promise<void> {
  try {
    await rm(lockDir, { recursive: true, force: true });
  } catch {
    // Another process may have removed it already; ignore
  }
}

function addHeldLock(lockDir: string): void {
  heldLockCounts.set(lockDir, (heldLockCounts.get(lockDir) ?? 0) + 1);
}

function removeHeldLock(lockDir: string): void {
  const count = (heldLockCounts.get(lockDir) ?? 0) - 1;
  if (count <= 0) {
    heldLockCounts.delete(lockDir);
  } else {
    heldLockCounts.set(lockDir, count);
  }
}

export async function withBranchMergeLock<T>(
  repoRoot: string,
  branchName: string,
  fn: () => Promise<T>,
  options?: BranchMergeLockOptions,
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 5 * 60 * 1000;
  const pollIntervalMs = options?.pollIntervalMs ?? 500;
  const lockDir = getLockDir(repoRoot, branchName);
  const startTime = Date.now();

  await ensureLockParentDirs(repoRoot);

  while (true) {
    const acquired = await tryAcquireLock(lockDir);
    if (acquired) {
      addHeldLock(lockDir);
      break;
    }

    if (await isStaleLock(lockDir)) {
      await removeStaleLock(lockDir);
      continue;
    }

    if (Date.now() - startTime >= timeoutMs) {
      throw new BranchMergeLockTimeoutError(branchName, timeoutMs);
    }

    await sleep(pollIntervalMs);
  }

  try {
    return await fn();
  } finally {
    removeHeldLock(lockDir);
    try {
      await rm(lockDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
