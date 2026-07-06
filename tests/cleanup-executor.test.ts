import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CleanupExecutor, CleanupPlanner } from '../src/cleanup.js';
import { resolveExecutable } from '../src/executable-resolution.js';
import type { SandcastleCleanupResource, SandcastleRuntimeRecord } from '../src/sandcastle-runtime-store.js';

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
  worktreePath?: string;
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
    worktreePath: input.worktreePath ?? path.join('/tmp', `worktree-${input.runId}`),
    phases: [],
    commits: [],
    logs: { run: `/tmp/${input.runId}.log`, phases: [] },
    terminal: { status: input.status },
    providerFailures: [],
    cleanupResources: input.cleanupResources ?? [],
    cleanupResults: [],
  };
}

test('deletes Sandcastle log cleanup resources', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  const recordPath = sandcastleRecordPath(repoRoot, 'run-done');
  mkdirSync(issuesDir, { recursive: true });
  const ticketPath = path.join(issuesDir, 'done.md');
  writeFileSync(ticketPath, '---\nstatus: done\n---\n');
  writeSandcastleRecord(
    recordPath,
    makeSandcastleRecord({
      runId: 'run-done',
      feature: 'feat',
      issue: 'done',
      ticketPath,
      status: 'completed',
      cleanupResources: [{ type: 'log', id: 'run-log', path: path.join(path.dirname(recordPath), 'run.log') }],
    }),
  );
  const logPath = path.join(path.dirname(recordPath), 'run.log');
  writeFileSync(logPath, 'log');

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  const result = new CleanupExecutor().execute(plan, repoRoot);
  assert.equal(existsSync(logPath), false);
  assert.ok(result.deleted.some((item) => item === logPath));
  const record = JSON.parse(readFileSync(recordPath, 'utf8')) as SandcastleRuntimeRecord;
  assert.equal(record.cleanupResults?.length, 1);
  assert.equal(record.cleanupResults?.[0]?.status, 'succeeded');
});

test('removes Sandcastle worktree cleanup resources', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  initRepo(repoRoot);
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  const recordPath = sandcastleRecordPath(repoRoot, 'run-done');
  mkdirSync(issuesDir, { recursive: true });
  const ticketPath = path.join(issuesDir, 'done.md');
  writeFileSync(ticketPath, '---\nstatus: done\n---\n');

  const branchName = 'afk/feat/done';
  git(repoRoot, ['branch', '--no-track', branchName]);
  const issueWorktreePath = path.join(repoRoot, '.worktree', 'feat-done');
  git(repoRoot, ['worktree', 'add', issueWorktreePath, branchName]);

  writeSandcastleRecord(
    recordPath,
    makeSandcastleRecord({
      runId: 'run-done',
      feature: 'feat',
      issue: 'done',
      ticketPath,
      status: 'completed',
      worktreePath: issueWorktreePath,
      cleanupResources: [{ type: 'worktree', id: 'issue-worktree', path: issueWorktreePath }],
    }),
  );

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  const result = new CleanupExecutor().execute(plan, repoRoot);
  assert.equal(existsSync(issueWorktreePath), false);
  assert.ok(result.deleted.some((item) => item === issueWorktreePath));
  const record = JSON.parse(readFileSync(recordPath, 'utf8')) as SandcastleRuntimeRecord;
  assert.equal(record.cleanupResults?.[0]?.status, 'succeeded');
});

test('removes Sandcastle branch cleanup resources', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  initRepo(repoRoot);
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  const recordPath = sandcastleRecordPath(repoRoot, 'run-done');
  mkdirSync(issuesDir, { recursive: true });
  const ticketPath = path.join(issuesDir, 'done.md');
  writeFileSync(ticketPath, '---\nstatus: done\n---\n');

  const branchName = 'afk/feat/done';
  git(repoRoot, ['branch', '--no-track', branchName]);

  writeSandcastleRecord(
    recordPath,
    makeSandcastleRecord({
      runId: 'run-done',
      feature: 'feat',
      issue: 'done',
      ticketPath,
      status: 'completed',
      cleanupResources: [{ type: 'branch', id: branchName }],
    }),
  );

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  const result = new CleanupExecutor().execute(plan, repoRoot);
  assert.equal(git(repoRoot, ['branch', '--list', branchName]), '');
  assert.ok(result.deleted.some((item) => item === `branch ${branchName}`));
  const record = JSON.parse(readFileSync(recordPath, 'utf8')) as SandcastleRuntimeRecord;
  assert.equal(record.cleanupResults?.[0]?.status, 'succeeded');
});

test('skips Sandcastle branch cleanup for non-afk branches', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  initRepo(repoRoot);
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  const recordPath = sandcastleRecordPath(repoRoot, 'run-done');
  mkdirSync(issuesDir, { recursive: true });
  const ticketPath = path.join(issuesDir, 'done.md');
  writeFileSync(ticketPath, '---\nstatus: done\n---\n');

  const branchName = 'main';

  writeSandcastleRecord(
    recordPath,
    makeSandcastleRecord({
      runId: 'run-done',
      feature: 'feat',
      issue: 'done',
      ticketPath,
      status: 'completed',
      cleanupResources: [{ type: 'branch', id: branchName }],
    }),
  );

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  const result = new CleanupExecutor().execute(plan, repoRoot);
  assert.ok(!result.deleted.some((item) => item === `branch ${branchName}`));
  assert.ok(result.deleted.some((item) => item === ticketPath));
  const record = JSON.parse(readFileSync(recordPath, 'utf8')) as SandcastleRuntimeRecord;
  assert.equal(record.cleanupResults?.[0]?.status, 'skipped');
  assert.match(record.cleanupResults?.[0]?.message ?? '', /not an AFK branch/);
});

test('retries pending post-merge cleanup and clears successful entries', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  initRepo(repoRoot);
  git(repoRoot, ['branch', 'feat']);
  const featureWorktreePath = path.join(repoRoot, '.worktree', 'feat');
  git(repoRoot, ['worktree', 'add', featureWorktreePath, 'feat']);
  const branchName = 'afk/feat/001';
  git(repoRoot, ['branch', '--no-track', branchName, 'feat']);
  const issueWorktreePath = path.join(repoRoot, '.worktree', 'feat-001');
  git(repoRoot, ['worktree', 'add', issueWorktreePath, branchName]);
  writeFileSync(path.join(issueWorktreePath, 'a.txt'), 'a\n');
  git(issueWorktreePath, ['add', 'a.txt']);
  git(issueWorktreePath, ['commit', '-m', 'ticket']);
  git(featureWorktreePath, ['merge', '--no-edit', branchName]);
  const mergedIssueTip = git(featureWorktreePath, ['rev-parse', `${branchName}^{commit}`]);

  const pendingPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'pending-post-merge-cleanup.json');
  mkdirSync(path.dirname(pendingPath), { recursive: true });
  writeFileSync(
    pendingPath,
    `${JSON.stringify([
      {
        feature: 'feat',
        issueName: '001',
        branchName,
        worktreePath: issueWorktreePath,
        featureWorktreePath,
        featureBranchName: 'feat',
        mergedIssueTip,
        failedAt: new Date().toISOString(),
      },
    ])}\n`,
  );

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  const result = new CleanupExecutor().execute(plan, repoRoot);
  assert.equal(result.postMergeCleanupResults.length, 1);
  assert.equal(result.postMergeCleanupResults[0]?.success, true);
  assert.equal(existsSync(issueWorktreePath), false);
  assert.equal(git(repoRoot, ['branch', '--list', branchName]), '');
  const persisted = JSON.parse(readFileSync(pendingPath, 'utf8')) as unknown[];
  assert.equal(persisted.length, 0);
});

test('removes planned orphaned issue worktree and branch', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  initRepo(repoRoot);
  git(repoRoot, ['branch', 'feat']);
  const branchName = 'afk/feat/001';
  git(repoRoot, ['branch', '--no-track', branchName, 'feat']);
  const issueWorktreePath = path.join(repoRoot, '.worktree', 'feat-001');
  git(repoRoot, ['worktree', 'add', issueWorktreePath, branchName]);

  const result = new CleanupExecutor().execute(
    {
      terminalTargets: [],
      issueDeletionTargets: [],
      runtimeArtifactTargets: [],
      sandcastleResourceTargets: [],
      orphanedWorktreeTargets: [
        { feature: 'feat', issueName: '001', branchName, worktreePath: issueWorktreePath, reason: 'terminal' },
      ],
      pendingPostMergeCleanupTargets: [],
      preservedIssues: [],
      preservedArtifacts: [],
      featureDirectoriesToDelete: [],
    },
    repoRoot,
  );

  assert.equal(result.orphanedWorktreeResults.length, 1);
  assert.equal(result.orphanedWorktreeResults[0]?.success, true);
  assert.equal(result.orphanedWorktreeResults[0]?.deletedWorktree, true);
  assert.equal(result.orphanedWorktreeResults[0]?.deletedBranch, true);
  assert.equal(existsSync(issueWorktreePath), false);
  assert.equal(git(repoRoot, ['branch', '--list', branchName]), '');
  assert.ok(result.deleted.some((item) => item === issueWorktreePath));
  assert.ok(result.deleted.some((item) => item === `branch ${branchName}`));
});

test('skips dirty orphaned issue worktree and reports reason', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  initRepo(repoRoot);
  git(repoRoot, ['branch', 'feat']);
  const branchName = 'afk/feat/001';
  git(repoRoot, ['branch', '--no-track', branchName, 'feat']);
  const issueWorktreePath = path.join(repoRoot, '.worktree', 'feat-001');
  git(repoRoot, ['worktree', 'add', issueWorktreePath, branchName]);
  writeFileSync(path.join(issueWorktreePath, 'dirty.txt'), 'dirty\n');

  const result = new CleanupExecutor().execute(
    {
      terminalTargets: [],
      issueDeletionTargets: [],
      runtimeArtifactTargets: [],
      sandcastleResourceTargets: [],
      orphanedWorktreeTargets: [
        { feature: 'feat', issueName: '001', branchName, worktreePath: issueWorktreePath, reason: 'terminal' },
      ],
      pendingPostMergeCleanupTargets: [],
      preservedIssues: [],
      preservedArtifacts: [],
      featureDirectoriesToDelete: [],
    },
    repoRoot,
  );

  assert.equal(result.orphanedWorktreeResults.length, 1);
  assert.equal(result.orphanedWorktreeResults[0]?.success, false);
  assert.equal(result.orphanedWorktreeResults[0]?.deletedWorktree, false);
  assert.equal(result.orphanedWorktreeResults[0]?.deletedBranch, false);
  assert.match(result.orphanedWorktreeResults[0]?.warning ?? '', /uncommitted changes/);
  assert.equal(existsSync(issueWorktreePath), true);
  assert.ok(git(repoRoot, ['branch', '--list', branchName]).includes(branchName));
});

test('retries pending post-merge cleanup and removes extra worktrees using the same branch', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  initRepo(repoRoot);
  git(repoRoot, ['branch', 'feat']);
  const featureWorktreePath = path.join(repoRoot, '.worktree', 'feat');
  git(repoRoot, ['worktree', 'add', featureWorktreePath, 'feat']);
  const branchName = 'afk/feat/001';
  git(repoRoot, ['branch', '--no-track', branchName, 'feat']);
  const issueWorktreePath = path.join(repoRoot, '.worktree', 'feat-001');
  git(repoRoot, ['worktree', 'add', issueWorktreePath, branchName]);
  writeFileSync(path.join(issueWorktreePath, 'a.txt'), 'a\n');
  git(issueWorktreePath, ['add', 'a.txt']);
  git(issueWorktreePath, ['commit', '-m', 'ticket']);
  // Add a second worktree for the same branch after the branch tip has been established
  const extraWorktreePath = path.join(repoRoot, '.worktree', 'feat-001-copy');
  git(repoRoot, ['worktree', 'add', '--force', extraWorktreePath, branchName]);
  git(featureWorktreePath, ['merge', '--no-edit', branchName]);
  const mergedIssueTip = git(featureWorktreePath, ['rev-parse', `${branchName}^{commit}`]);

  const pendingPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'pending-post-merge-cleanup.json');
  mkdirSync(path.dirname(pendingPath), { recursive: true });
  writeFileSync(
    pendingPath,
    `${JSON.stringify([
      {
        feature: 'feat',
        issueName: '001',
        branchName,
        worktreePath: issueWorktreePath,
        featureWorktreePath,
        featureBranchName: 'feat',
        mergedIssueTip,
        failedAt: new Date().toISOString(),
      },
    ])}\n`,
  );

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  const result = new CleanupExecutor().execute(plan, repoRoot);
  assert.equal(result.postMergeCleanupResults.length, 1);
  assert.equal(result.postMergeCleanupResults[0]?.success, true);
  assert.equal(result.postMergeCleanupResults[0]?.deletedWorktree, true);
  assert.equal(result.postMergeCleanupResults[0]?.deletedBranch, true);
  assert.equal(existsSync(issueWorktreePath), false);
  assert.equal(existsSync(extraWorktreePath), false);
  assert.equal(git(repoRoot, ['branch', '--list', branchName]), '');
  const persisted = JSON.parse(readFileSync(pendingPath, 'utf8')) as unknown[];
  assert.equal(persisted.length, 0);
});

test('retries pending post-merge cleanup and tolerates unreachable issue tip with warning', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  initRepo(repoRoot);
  git(repoRoot, ['branch', 'feat']);
  const featureWorktreePath = path.join(repoRoot, '.worktree', 'feat');
  git(repoRoot, ['worktree', 'add', featureWorktreePath, 'feat']);
  const branchName = 'afk/feat/001';
  git(repoRoot, ['branch', '--no-track', branchName, 'feat']);
  const issueWorktreePath = path.join(repoRoot, '.worktree', 'feat-001');
  git(repoRoot, ['worktree', 'add', issueWorktreePath, branchName]);
  writeFileSync(path.join(issueWorktreePath, 'a.txt'), 'a\n');
  git(issueWorktreePath, ['add', 'a.txt']);
  git(issueWorktreePath, ['commit', '-m', 'ticket']);

  // Use a fake merged tip that is not an ancestor of the feature branch
  const mergedIssueTip = '0000000000000000000000000000000000000000';

  const pendingPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'pending-post-merge-cleanup.json');
  mkdirSync(path.dirname(pendingPath), { recursive: true });
  writeFileSync(
    pendingPath,
    `${JSON.stringify([
      {
        feature: 'feat',
        issueName: '001',
        branchName,
        worktreePath: issueWorktreePath,
        featureWorktreePath,
        featureBranchName: 'feat',
        mergedIssueTip,
        failedAt: new Date().toISOString(),
      },
    ])}\n`,
  );

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  const result = new CleanupExecutor().execute(plan, repoRoot);
  assert.equal(result.postMergeCleanupResults.length, 1);
  assert.equal(result.postMergeCleanupResults[0]?.success, true);
  assert.equal(result.postMergeCleanupResults[0]?.deletedWorktree, true);
  assert.equal(result.postMergeCleanupResults[0]?.deletedBranch, true);
  assert.ok(result.postMergeCleanupResults[0]?.warning?.includes('merge proof failed'));
  assert.equal(existsSync(issueWorktreePath), false);
  assert.equal(git(repoRoot, ['branch', '--list', branchName]), '');
  const persisted = JSON.parse(readFileSync(pendingPath, 'utf8')) as unknown[];
  assert.equal(persisted.length, 0);
});

test('retries pending post-merge cleanup and tolerates already-deleted branch', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  initRepo(repoRoot);
  git(repoRoot, ['branch', 'feat']);
  const featureWorktreePath = path.join(repoRoot, '.worktree', 'feat');
  git(repoRoot, ['worktree', 'add', featureWorktreePath, 'feat']);
  const branchName = 'afk/feat/001';
  git(repoRoot, ['branch', '--no-track', branchName, 'feat']);
  const issueWorktreePath = path.join(repoRoot, '.worktree', 'feat-001');
  git(repoRoot, ['worktree', 'add', issueWorktreePath, branchName]);
  writeFileSync(path.join(issueWorktreePath, 'a.txt'), 'a\n');
  git(issueWorktreePath, ['add', 'a.txt']);
  git(issueWorktreePath, ['commit', '-m', 'ticket']);
  git(featureWorktreePath, ['merge', '--no-edit', branchName]);
  const mergedIssueTip = git(featureWorktreePath, ['rev-parse', `${branchName}^{commit}`]);

  // Delete the branch before retry to simulate a partially-completed prior cleanup
  git(repoRoot, ['worktree', 'remove', '-f', issueWorktreePath]);
  git(repoRoot, ['branch', '-D', branchName]);

  const pendingPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'pending-post-merge-cleanup.json');
  mkdirSync(path.dirname(pendingPath), { recursive: true });
  writeFileSync(
    pendingPath,
    `${JSON.stringify([
      {
        feature: 'feat',
        issueName: '001',
        branchName,
        worktreePath: issueWorktreePath,
        featureWorktreePath,
        featureBranchName: 'feat',
        mergedIssueTip,
        failedAt: new Date().toISOString(),
      },
    ])}\n`,
  );

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  const result = new CleanupExecutor().execute(plan, repoRoot);
  assert.equal(result.postMergeCleanupResults.length, 1);
  assert.equal(result.postMergeCleanupResults[0]?.success, true);
  assert.equal(result.postMergeCleanupResults[0]?.deletedWorktree, false);
  assert.equal(result.postMergeCleanupResults[0]?.deletedBranch, false);
  assert.ok(result.postMergeCleanupResults[0]?.warning?.includes('already deleted'));
  const persisted = JSON.parse(readFileSync(pendingPath, 'utf8')) as unknown[];
  assert.equal(persisted.length, 0);
});
