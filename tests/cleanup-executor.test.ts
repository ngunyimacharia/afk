import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CleanupExecutor, CleanupPlanner } from '../src/cleanup.js';

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
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
      pendingPostMergeCleanupTargets: [],
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
