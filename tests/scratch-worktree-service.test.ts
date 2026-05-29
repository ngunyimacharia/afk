import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { resolveExecutable } from '../src/executable-resolution.js';
import { ScratchWorktreeService } from '../src/scratch-worktree-service.js';
import { mkRepoLocalTempDir } from './helpers/temp-repo.js';

const GIT_PATH = resolveExecutable('git');

function git(repoRoot: string, args: string[]): string {
  return execFileSync(GIT_PATH, args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function createRepo(prefix: string): string {
  const repoRoot = mkRepoLocalTempDir(prefix);
  git(repoRoot, ['init', '-b', 'main']);
  writeFileSync(path.join(repoRoot, 'README.md'), 'test\n');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'test']);
  return repoRoot;
}

test('creates a scratch worktree branched from the feature branch by default', () => {
  const repoRoot = createRepo('afk-scratch-create-');
  git(repoRoot, ['checkout', '-b', 'my-feature']);
  writeFileSync(path.join(repoRoot, 'feature.txt'), 'feature work\n');
  git(repoRoot, ['add', 'feature.txt']);
  git(repoRoot, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'feature']);

  const service = new ScratchWorktreeService();
  const result = service.createScratchWorktree({
    repoRoot,
    featureSlug: 'my-feature',
    issueName: '01-test',
  });

  assert.equal(result.featureSlug, 'my-feature');
  assert.equal(result.defaultWorktreeName, 'my-feature-01-test');
  assert.equal(result.effectiveWorktreeName, 'my-feature-01-test');
  assert.equal(result.defaultBranchName, 'afk/my-feature/01-test');
  assert.equal(result.effectiveBranchName, 'afk/my-feature/01-test');
  assert.equal(result.worktreePath, path.join(repoRoot, '.worktree', 'my-feature-01-test'));
  assert.equal(existsSync(result.worktreePath), true);
  assert.equal(existsSync(path.join(result.worktreePath, 'feature.txt')), true);
  assert.equal(readFileSync(path.join(result.worktreePath, 'feature.txt'), 'utf8'), 'feature work\n');
  assert.match(git(repoRoot, ['branch', '--list', 'afk/my-feature/01-test']), /afk\/my-feature\/01-test/);
  const worktreeList = git(repoRoot, ['worktree', 'list', '--porcelain']);
  assert.equal(worktreeList.includes(`worktree ${result.worktreePath}`), true);
});

test('returns existing worktree when called twice for the same feature and issue', () => {
  const repoRoot = createRepo('afk-scratch-idempotent-');
  git(repoRoot, ['branch', 'my-feature']);

  const service = new ScratchWorktreeService();
  const first = service.createScratchWorktree({
    repoRoot,
    featureSlug: 'my-feature',
    issueName: '02-test',
  });

  // Add a file to the existing worktree to distinguish it from a fresh one
  writeFileSync(path.join(first.worktreePath, 'marker.txt'), 'marker\n');

  const second = service.createScratchWorktree({
    repoRoot,
    featureSlug: 'my-feature',
    issueName: '02-test',
  });

  assert.equal(second.worktreePath, first.worktreePath);
  assert.equal(existsSync(path.join(second.worktreePath, 'marker.txt')), true);
  assert.equal(readFileSync(path.join(second.worktreePath, 'marker.txt'), 'utf8'), 'marker\n');
});

test('branches from custom baseRef when provided', () => {
  const repoRoot = createRepo('afk-scratch-baseref-');
  git(repoRoot, ['checkout', '-b', 'my-feature']);
  writeFileSync(path.join(repoRoot, 'feature.txt'), 'feature\n');
  git(repoRoot, ['add', 'feature.txt']);
  git(repoRoot, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'feature']);

  // Create a post-merge commit on main that feature branch doesn't have
  git(repoRoot, ['checkout', 'main']);
  writeFileSync(path.join(repoRoot, 'main.txt'), 'main\n');
  git(repoRoot, ['add', 'main.txt']);
  git(repoRoot, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'main-commit']);

  const mergeBase = git(repoRoot, ['rev-parse', 'HEAD']);

  const service = new ScratchWorktreeService();
  const result = service.createScratchWorktree({
    repoRoot,
    featureSlug: 'my-feature',
    issueName: '03-test',
    baseRef: mergeBase,
  });

  assert.equal(existsSync(path.join(result.worktreePath, 'main.txt')), true);
  assert.equal(existsSync(path.join(result.worktreePath, 'feature.txt')), false);
});

test('copies readiness artifacts into scratch worktree', () => {
  const repoRoot = createRepo('afk-scratch-artifacts-');
  git(repoRoot, ['branch', 'my-feature']);
  mkdirSync(path.join(repoRoot, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  writeFileSync(path.join(repoRoot, '.env.testing'), 'TEST_VALUE=yes\n');

  const service = new ScratchWorktreeService();
  const result = service.createScratchWorktree({
    repoRoot,
    featureSlug: 'my-feature',
    issueName: '04-test',
  });

  assert.equal(existsSync(path.join(result.worktreePath, 'node_modules', 'pkg', 'index.js')), true);
  assert.equal(readFileSync(path.join(result.worktreePath, '.env.testing'), 'utf8'), 'TEST_VALUE=yes\n');
  assert.equal(result.readiness?.dependencyCopies.find((item) => item.name === 'node_modules')?.decision, 'copied');
  assert.equal(result.readiness?.envTestingCopy.decision, 'copied');
});

test('removeScratchWorktree deletes worktree directory and branch', () => {
  const repoRoot = createRepo('afk-scratch-remove-');
  git(repoRoot, ['branch', 'my-feature']);

  const service = new ScratchWorktreeService();
  const result = service.createScratchWorktree({
    repoRoot,
    featureSlug: 'my-feature',
    issueName: '05-test',
  });

  assert.equal(existsSync(result.worktreePath), true);
  assert.match(git(repoRoot, ['branch', '--list', 'afk/my-feature/05-test']), /afk\/my-feature\/05-test/);

  service.removeScratchWorktree(result);

  assert.equal(existsSync(result.worktreePath), false);
  assert.equal(git(repoRoot, ['branch', '--list', 'afk/my-feature/05-test']), '');
  const worktreeList = git(repoRoot, ['worktree', 'list', '--porcelain']);
  assert.equal(worktreeList.includes('branch refs/heads/afk/my-feature/05-test'), false);
});

test('removeScratchWorktree does not affect the feature worktree or repo state', () => {
  const repoRoot = createRepo('afk-scratch-remove-safe-');
  git(repoRoot, ['branch', 'my-feature']);

  // Create main worktree
  const mainWorktreePath = path.join(repoRoot, '.worktree', 'my-feature');
  git(repoRoot, ['worktree', 'add', mainWorktreePath, 'my-feature']);

  const service = new ScratchWorktreeService();
  const scratch = service.createScratchWorktree({
    repoRoot,
    featureSlug: 'my-feature',
    issueName: '06-test',
  });

  service.removeScratchWorktree(scratch);

  // Main worktree should still exist
  assert.equal(existsSync(mainWorktreePath), true);
  assert.match(git(repoRoot, ['branch', '--list', 'my-feature']), /my-feature/);
  const worktreeList = git(repoRoot, ['worktree', 'list', '--porcelain']);
  assert.equal(worktreeList.includes('branch refs/heads/my-feature'), true);
});

test('fails clearly when target worktree path exists but is not registered', () => {
  const repoRoot = createRepo('afk-scratch-stale-');
  git(repoRoot, ['branch', 'my-feature']);
  mkdirSync(path.join(repoRoot, '.worktree', 'my-feature-07-test'), { recursive: true });

  const service = new ScratchWorktreeService();
  assert.throws(
    () =>
      service.createScratchWorktree({
        repoRoot,
        featureSlug: 'my-feature',
        issueName: '07-test',
      }),
    /already exists but is not registered with git/,
  );
});
