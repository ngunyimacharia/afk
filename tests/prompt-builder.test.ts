import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPrompt } from '../src/prompt-builder.js';

test('prompt consumes prepared checkout context', () => {
  const prompt = buildPrompt({
    checkout: { featureSlug: 'feat', defaultWorktreeName: 'feat', effectiveWorktreeName: 'feat-tree', defaultBranchName: 'afk/feat', effectiveBranchName: 'afk/feat-tree', worktreePath: '/repo/.git/worktrees/feat-tree' },
    ticket: { path: '/repo/.scratch/feat/issues/01.md', feature: 'feat', issueName: '01', label: 'feat/01', executorAfk: true },
    ticketContent: 'Status: ready-for-agent\n',
  });
  assert.match(prompt, /prepared checkout context/);
  assert.match(prompt, /feat-tree/);
  assert.match(prompt, /Ticket file to update: \/repo\/\.scratch\/feat\/issues\/01\.md/);
  assert.match(prompt, /Do not put the final AFK summary only in the assistant response, runtime log, or commit message/);
  assert.match(prompt, /Status: ready-for-agent/);
  assert.doesNotMatch(prompt, /git worktree add|git worktree list|change into the worktree/i);
});
