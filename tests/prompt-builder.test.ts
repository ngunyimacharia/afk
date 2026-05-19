import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('afk prompt includes budget and handoff guardrails', () => {
  const source = readFileSync(new URL('../src/prompts/afk-prompt.md', import.meta.url), 'utf8');
  assert.match(source, /Do not create fixup commits unless the reviewer reported concrete findings tied to this ticket\./);
  assert.match(source, /Do not run or repair disabled test suites unless the selected ticket explicitly requires that work\./);
  assert.match(source, /Do not rediscover or retry known readiness failures unless the selected ticket explicitly requires fixing them\./);
  assert.match(source, /append a structured `## AFK Summary` block/);
});
