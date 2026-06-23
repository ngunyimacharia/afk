import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CleanupExecutor, CleanupPlanner } from '../src/cleanup.js';
import { resolveExecutable } from '../src/executable-resolution.js';

const GIT_PATH = resolveExecutable('git');

function git(repoRoot: string, args: string[]): string {
  return execFileSync(GIT_PATH, args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

test('executes only approved cleanup targets', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuePath = path.join(repoRoot, '.scratch', 'feat', 'issues', 'done.md');
  const logPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-done.log');
  mkdirSync(path.dirname(issuePath), { recursive: true });
  mkdirSync(path.dirname(logPath), { recursive: true });
  writeFileSync(issuePath, 'x');
  writeFileSync(logPath, 'x');
  const result = new CleanupExecutor().execute(
    {
      terminalTargets: [{ feature: 'feat', issueName: 'done', issuePath, logPath, reason: 'done' }],
      issueDeletionTargets: [{ feature: 'feat', issueName: 'done', issuePath, reason: 'done' }],
      runtimeArtifactTargets: [{ feature: 'feat', issueName: 'done', logPath }],
      pendingPostMergeCleanupTargets: [],
      orphanedWorktreeTargets: [],
      preservedIssues: [],
      preservedArtifacts: [],
      featureDirectoriesToDelete: [],
    },
    repoRoot,
  );
  assert.equal(existsSync(issuePath), false);
  assert.equal(existsSync(logPath), false);
  assert.equal(result.deleted.length >= 2, true);
  assert.equal(result.postMergeCleanupResults.length, 0);
});

test('retries pending post-merge cleanup and clears successful entries', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  writeFileSync(path.join(repoRoot, 'README.md'), 'test\n');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-m', 'init']);
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
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  writeFileSync(path.join(repoRoot, 'README.md'), 'test\n');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-m', 'init']);
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
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  writeFileSync(path.join(repoRoot, 'README.md'), 'test\n');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-m', 'init']);
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
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  writeFileSync(path.join(repoRoot, 'README.md'), 'test\n');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-m', 'init']);
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
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  writeFileSync(path.join(repoRoot, 'README.md'), 'test\n');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-m', 'init']);
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
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  writeFileSync(path.join(repoRoot, 'README.md'), 'test\n');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-m', 'init']);
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
