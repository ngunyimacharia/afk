import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildPrompt } from '../src/prompt-builder.js';
import { WorktreePreparationService } from '../src/worktree-preparation-service.js';

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function createRepo(prefix: string): string {
  const repoRoot = mkdtempSync(path.join(tmpdir(), prefix));
  git(repoRoot, ['init', '-b', 'main']);
  writeFileSync(path.join(repoRoot, 'README.md'), 'test\n');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'test']);
  return repoRoot;
}

test('derives names and honors overrides', () => {
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
  assert.match(buildPrompt({ checkout, ticket: { path: '/tmp/ticket.md', feature: 'feature-a', issueName: '001', label: 'feature-a/001', executorAfk: true }, ticketContent: 'Status: ready-for-agent' }), /prepared checkout context/);
});

test('creates or reuses a persistent local worktree and branch', () => {
  const repoRoot = createRepo('afk-worktree-reuse-');

  const service = new WorktreePreparationService();
  const first = service.prepare({ repoRoot, featureSlug: 'feat-one' });
  const second = service.prepare({ repoRoot, featureSlug: 'feat-one' });

  assert.equal(first.effectiveWorktreeName, 'feat-one');
  assert.equal(second.effectiveWorktreeName, 'feat-one');
  assert.match(git(repoRoot, ['branch', '--list', 'afk/feat-one']), /afk\/feat-one/);
  assert.equal(git(repoRoot, ['worktree', 'list', '--porcelain']).includes(`worktree ${realpathSync(first.worktreePath)}`), true);
});

test('fails clearly when git rejects the requested branch state', () => {
  const repoRoot = createRepo('afk-worktree-fail-');
  git(repoRoot, ['branch', 'afk/conflict']);

  const service = new WorktreePreparationService();
  assert.throws(() => service.prepare({ repoRoot, featureSlug: 'conflict', ticketOverrides: { afk_branch: 'invalid branch name' } }));
});

test('prepares worktrees under ignored repo-local .worktree directory', () => {
  const repoRoot = createRepo('afk-worktree-');
  const result = new WorktreePreparationService().prepare({ repoRoot, featureSlug: 'feature-a' });

  assert.equal(result.worktreePath, path.join(repoRoot, '.worktree', 'feature-a'));
  assert.equal(result.effectiveBranchName, 'afk/feature-a');
  assert.equal(existsSync(path.join(repoRoot, '.worktree')), true);
  assert.equal(existsSync(result.worktreePath), true);
  assert.match(readFileSync(path.join(repoRoot, '.gitignore'), 'utf8'), /^\.worktree\/$/m);
});

test('preserves existing gitignore contents when adding worktree ignore', () => {
  const repoRoot = createRepo('afk-worktree-ignore-');
  writeFileSync(path.join(repoRoot, '.gitignore'), '.scratch\n');

  new WorktreePreparationService().prepare({ repoRoot, featureSlug: 'feature-b' });

  assert.equal(readFileSync(path.join(repoRoot, '.gitignore'), 'utf8'), '.scratch\n.worktree/\n');
});
