import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildPrompt } from '../src/prompt-builder.js';
import { WorktreePreparationService } from '../src/worktree-preparation-service.js';

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

test('derives names and honors overrides', () => {
  const service = new WorktreePreparationService();
  const checkout = {
    featureSlug: 'feature-a',
    defaultWorktreeName: 'feature-a',
    effectiveWorktreeName: 'custom-tree',
    defaultBranchName: 'afk/feature-a',
    effectiveBranchName: 'local/branch',
    worktreePath: '/repo/custom-tree',
  };
  assert.equal(checkout.defaultWorktreeName, 'feature-a');
  assert.equal(checkout.effectiveWorktreeName, 'custom-tree');
  assert.equal(checkout.defaultBranchName, 'afk/feature-a');
  assert.equal(checkout.effectiveBranchName, 'local/branch');
  assert.match(buildPrompt({ checkout }), /prepared checkout context/);
});

test('creates or reuses a persistent local worktree and branch', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-worktree-'));
  git(repoRoot, ['init']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test User']);
  execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: repoRoot });

  const service = new WorktreePreparationService();
  const first = service.prepare({ repoRoot, featureSlug: 'feat-one' });
  const second = service.prepare({ repoRoot, featureSlug: 'feat-one' });

  assert.equal(first.effectiveWorktreeName, 'feat-one');
  assert.equal(second.effectiveWorktreeName, 'feat-one');
  assert.equal(git(repoRoot, ['branch', '--list', 'afk/feat-one']), 'afk/feat-one');
  assert.equal(git(repoRoot, ['worktree', 'list', '--porcelain']).includes(`worktree ${first.worktreePath}`), true);
});

test('fails clearly when git rejects the requested branch state', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-worktree-fail-'));
  git(repoRoot, ['init']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test User']);
  execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: repoRoot });
  git(repoRoot, ['branch', 'afk/conflict']);

  const service = new WorktreePreparationService();
  assert.throws(() => service.prepare({ repoRoot, featureSlug: 'conflict', ticketOverrides: { afk_branch: 'invalid branch name' } }));
});
