import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runAfk } from '../src/cli.js';
import type { SandcastleCleanupResource, SandcastleRuntimeRecord } from '../src/sandcastle-runtime-store.js';

function sandcastleRecordPath(repoRoot: string, runId: string): string {
  return path.join(repoRoot, '.scratch', 'sandcastle-runtime', 'runs', runId, 'record.json');
}

function writeSandcastleRecord(recordPath: string, record: SandcastleRuntimeRecord): void {
  mkdirSync(path.dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
}

function makeSandcastleRecord(input: {
  runId: string;
  feature: string;
  issue: string;
  ticketPath: string;
  status: 'running' | 'completed' | 'handoff' | 'failed' | 'blocked' | 'interrupted';
  cleanupResources?: SandcastleCleanupResource[];
}): SandcastleRuntimeRecord {
  return {
    schemaVersion: 1,
    runId: input.runId,
    createdAt: '2026-05-18T00:00:00.000Z',
    updatedAt: '2026-05-18T00:00:00.000Z',
    ticket: {
      featureSlug: input.feature,
      issueName: input.issue,
      label: `${input.feature}/${input.issue}`,
      ticketPath: input.ticketPath,
    },
    trackerSource: 'scratch',
    provider: { provider: 'opencode', model: 'test' },
    sandbox: { mode: 'none' },
    branch: `afk/${input.feature}/${input.issue}`,
    worktreePath: path.join('/tmp', `worktree-${input.runId}`),
    phases: [],
    commits: [],
    logs: { run: `/tmp/${input.runId}.log`, phases: [] },
    terminal: { status: input.status },
    providerFailures: [],
    cleanupResources: input.cleanupResources ?? [],
    cleanupResults: [],
  };
}

function runCleanup(repoRoot: string, ...args: string[]) {
  const originalArgs = [...process.argv];
  process.argv = ['node', 'afk', 'afk-cleanup', ...args];
  return runAfk(repoRoot).finally(() => {
    process.argv = originalArgs;
  });
}

test('afk-cleanup executes Sandcastle cleanup without confirmation phrase', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  const ticketPath = path.join(issuesDir, 'done.md');
  writeFileSync(ticketPath, '---\nstatus: done\n---\n');
  const recordPath = sandcastleRecordPath(repoRoot, 'run-done');
  const logPath = path.join(path.dirname(recordPath), 'run.log');
  writeSandcastleRecord(
    recordPath,
    makeSandcastleRecord({
      runId: 'run-done',
      feature: 'feat',
      issue: 'done',
      ticketPath,
      status: 'completed',
      cleanupResources: [{ type: 'log', id: 'run-log', path: logPath }],
    }),
  );
  writeFileSync(logPath, 'log');

  const result = await runCleanup(repoRoot);
  assert.match(result.message, /AFK Cleanup Plan/);
  assert.match(result.message, /Executed:/);
  assert.match(result.message, /run\.log/);
  assert.equal(existsSync(logPath), false);
});

test('cleanup preserves running Sandcastle tickets', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  const ticketPath = path.join(issuesDir, 'human.md');
  writeFileSync(ticketPath, '---\nstatus: ready-for-human\n---\n');
  writeSandcastleRecord(
    sandcastleRecordPath(repoRoot, 'run-human'),
    makeSandcastleRecord({
      runId: 'run-human',
      feature: 'feat',
      issue: 'human',
      ticketPath,
      status: 'running',
    }),
  );
  const result = await runCleanup(repoRoot);
  assert.match(result.message, /human\.md/);
  assert.match(result.message, /Preserved tickets/);
  assert.equal(existsSync(ticketPath), true);
});

test('afk-cleanup --dry-run prints plan without deleting files', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  const ticketPath = path.join(issuesDir, 'done.md');
  writeFileSync(ticketPath, '---\nstatus: done\n---\n');
  const recordPath = sandcastleRecordPath(repoRoot, 'run-done');
  const logPath = path.join(path.dirname(recordPath), 'run.log');
  writeSandcastleRecord(
    recordPath,
    makeSandcastleRecord({
      runId: 'run-done',
      feature: 'feat',
      issue: 'done',
      ticketPath,
      status: 'completed',
      cleanupResources: [{ type: 'log', id: 'run-log', path: logPath }],
    }),
  );
  writeFileSync(logPath, 'log');

  const result = await runCleanup(repoRoot, '--dry-run');
  assert.match(result.message, /AFK Cleanup Plan/);
  assert.match(result.message, /Sandcastle cleanup resources/);
  assert.match(result.message, /run\.log/);
  assert.match(result.message, /Dry run only\. No files were deleted\./);
  assert.doesNotMatch(result.message, /Executed:/);
  assert.equal(existsSync(logPath), true);
});

test('afk-cleanup shows pending post-merge cleanup retries from persisted state', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const logsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs');
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    path.join(logsDir, 'pending-post-merge-cleanup.json'),
    `${JSON.stringify([
      {
        feature: 'feat',
        issueName: '001',
        branchName: 'afk/feat/001',
        worktreePath: '/tmp/issue-worktree',
        featureWorktreePath: '/tmp/feature-worktree',
        featureBranchName: 'feat',
        mergedIssueTip: 'abc123',
        failedAt: new Date().toISOString(),
        warning: 'issue worktree is unavailable',
      },
    ])}\n`,
  );
  const result = await runCleanup(repoRoot, '--dry-run');
  assert.match(result.message, /feat\/001/);
  assert.match(result.message, /pending retry|unavailable/);
});
