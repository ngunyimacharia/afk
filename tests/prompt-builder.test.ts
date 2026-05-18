import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPrompt } from '../src/prompt-builder.js';

test('prompt consumes prepared checkout context', () => {
  const prompt = buildPrompt({ checkout: { featureSlug: 'feat', defaultWorktreeName: 'feat', effectiveWorktreeName: 'feat-tree', defaultBranchName: 'afk/feat', effectiveBranchName: 'afk/feat-tree', worktreePath: '/repo/.git/worktrees/feat-tree' } });
  assert.match(prompt, /prepared checkout context/);
  assert.match(prompt, /feat-tree/);
  assert.doesNotMatch(prompt, /git worktree add|git worktree list|change into the worktree/i);
});
