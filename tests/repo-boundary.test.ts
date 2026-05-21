import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  areAllPathsAllowedForAfkWrite,
  areAllPathsInAssignedWorktree,
  areAllPathsInsideRepoRoot,
  classifyPathAgainstRepoRoot,
} from '../src/repo-boundary.js';

test('classifies paths under repo root as allowed', () => {
  assert.equal(
    classifyPathAgainstRepoRoot('/Users/raven/Code/finance-ant/mobile', '/Users/raven/Code/finance-ant/mobile')
      .classification,
    'inside-repo',
  );
  assert.equal(
    classifyPathAgainstRepoRoot(
      '/Users/raven/Code/finance-ant/mobile',
      '/Users/raven/Code/finance-ant/mobile/.git/index',
    ).classification,
    'inside-repo',
  );
  assert.equal(
    classifyPathAgainstRepoRoot(
      '/Users/raven/Code/finance-ant/mobile',
      '/Users/raven/Code/finance-ant/mobile/.worktree/feature-a/file.php',
    ).classification,
    'inside-repo',
  );
});

test('classifies paths outside repo root as denied', () => {
  assert.equal(
    classifyPathAgainstRepoRoot('/Users/raven/Code/finance-ant/mobile', '/Users/raven/Library/Mail').classification,
    'outside-repo',
  );
  assert.equal(
    classifyPathAgainstRepoRoot('/Users/raven/Code/finance-ant/mobile', '/Users/raven/Downloads').classification,
    'outside-repo',
  );
  assert.equal(
    classifyPathAgainstRepoRoot('/Users/raven/Code/finance-ant/mobile', '/Users/raven/Code/other-project/file.md')
      .classification,
    'outside-repo',
  );
});

test('requires all permission patterns to stay inside repo root', () => {
  assert.equal(areAllPathsInsideRepoRoot('/repo', ['/repo/.git/*', '/repo/.worktree/a/*']), true);
  assert.equal(areAllPathsInsideRepoRoot('/repo', ['/repo/.git/*', '/tmp/outside/*']), false);
});

test('allows AFK writes only in assigned worktree or root scratch', () => {
  const input = {
    repoRoot: '/repo',
    worktreePath: '/repo/.worktree/feature',
    otherWorktreePaths: ['/repo/.worktree/other'],
  };

  assert.equal(areAllPathsAllowedForAfkWrite({ ...input, targets: ['/repo/.worktree/feature/app/File.php'] }), true);
  assert.equal(areAllPathsAllowedForAfkWrite({ ...input, targets: ['/repo/.scratch/feature/issues/01.md'] }), true);
  assert.equal(areAllPathsAllowedForAfkWrite({ ...input, targets: ['/repo/app/File.php'] }), false);
  assert.equal(areAllPathsAllowedForAfkWrite({ ...input, targets: ['/repo/.worktree/other/app/File.php'] }), false);
  assert.equal(areAllPathsAllowedForAfkWrite({ ...input, targets: ['/tmp/outside.php'] }), false);
});

test('resolves relative permission paths against repo root', () => {
  const input = {
    repoRoot: '/repo',
    worktreePath: '/repo/.worktree/feature',
    otherWorktreePaths: ['/repo/.worktree/other'],
  };

  assert.equal(areAllPathsAllowedForAfkWrite({ ...input, targets: ['.worktree/feature/app/File.php'] }), true);
  assert.equal(areAllPathsAllowedForAfkWrite({ ...input, targets: ['.worktree/other/app/File.php'] }), false);
});

test('recognizes all files inside assigned worktree', () => {
  const input = {
    repoRoot: '/repo',
    worktreePath: '/repo/.worktree/feature',
  };

  assert.equal(areAllPathsInAssignedWorktree({ ...input, targets: ['/repo/.worktree/feature/.env.testing'] }), true);
  assert.equal(areAllPathsInAssignedWorktree({ ...input, targets: ['.worktree/feature/.env.testing'] }), true);
  assert.equal(areAllPathsInAssignedWorktree({ ...input, targets: ['/repo/.scratch/feature/issues/01.md'] }), false);
  assert.equal(areAllPathsInAssignedWorktree({ ...input, targets: ['/repo/.worktree/other/.env.testing'] }), false);
});
