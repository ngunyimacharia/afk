import assert from 'node:assert/strict';
import { test } from 'node:test';
import { areAllPathsInsideRepoRoot, classifyPathAgainstRepoRoot } from '../src/repo-boundary.js';

test('classifies paths under repo root as allowed', () => {
  assert.equal(classifyPathAgainstRepoRoot('/Users/raven/Code/finance-ant/mobile', '/Users/raven/Code/finance-ant/mobile').classification, 'inside-repo');
  assert.equal(classifyPathAgainstRepoRoot('/Users/raven/Code/finance-ant/mobile', '/Users/raven/Code/finance-ant/mobile/.git/index').classification, 'inside-repo');
  assert.equal(classifyPathAgainstRepoRoot('/Users/raven/Code/finance-ant/mobile', '/Users/raven/Code/finance-ant/mobile/.worktree/feature-a/file.php').classification, 'inside-repo');
});

test('classifies paths outside repo root as denied', () => {
  assert.equal(classifyPathAgainstRepoRoot('/Users/raven/Code/finance-ant/mobile', '/Users/raven/Library/Mail').classification, 'outside-repo');
  assert.equal(classifyPathAgainstRepoRoot('/Users/raven/Code/finance-ant/mobile', '/Users/raven/Downloads').classification, 'outside-repo');
  assert.equal(classifyPathAgainstRepoRoot('/Users/raven/Code/finance-ant/mobile', '/Users/raven/Code/other-project/file.md').classification, 'outside-repo');
});

test('requires all permission patterns to stay inside repo root', () => {
  assert.equal(areAllPathsInsideRepoRoot('/repo', ['/repo/.git/*', '/repo/.worktree/a/*']), true);
  assert.equal(areAllPathsInsideRepoRoot('/repo', ['/repo/.git/*', '/tmp/outside/*']), false);
});
