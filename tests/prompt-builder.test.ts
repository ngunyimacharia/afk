import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildLaunchPlan } from '../src/launch-context-builder.js';
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
  assert.match(prompt, /## AFK State Snapshot/);
  assert.doesNotMatch(prompt, /git worktree add|git worktree list|change into the worktree/i);
});

test('afk prompt includes budget and handoff guardrails', () => {
  const source = readFileSync(new URL('../src/prompts/afk-prompt.md', import.meta.url), 'utf8');
  assert.match(source, /Do not create fixup commits unless the reviewer reported concrete findings tied to this ticket\./);
  assert.match(source, /Do not run or repair disabled test suites unless the selected ticket explicitly requires that work\./);
  assert.match(source, /Do not rediscover or retry known readiness failures unless the selected ticket explicitly requires fixing them\./);
  assert.match(source, /append a structured `## AFK Summary` block/);
});

test('snapshot includes dependency/runtime/readiness facts and excludes unrelated scratch content', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-prompt-snapshot-'));
  const ticketPath = path.join(repoRoot, '.scratch', 'feat', 'issues', '03.md');
  const unrelatedScratchPath = path.join(repoRoot, '.scratch', 'other-feature', 'issues', '99.md');
  mkdirSync(path.dirname(ticketPath), { recursive: true });
  mkdirSync(path.dirname(unrelatedScratchPath), { recursive: true });
  writeFileSync(ticketPath, 'Status: ready-for-agent\n');
  writeFileSync(unrelatedScratchPath, 'super secret scratch text\n');
  mkdirSync(path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata'), { recursive: true });
  mkdirSync(path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'sentinels'), { recursive: true });
  writeFileSync(path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-01.json'), JSON.stringify({ STATUS: 'completed' }));
  writeFileSync(path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-02.json'), JSON.stringify({ STATUS: 'failed' }));
  writeFileSync(path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'sentinels', 'feat-01.done'), 'done');
  writeFileSync(path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'sentinels', 'feat-02.failed'), 'failed');
  writeFileSync(path.join(repoRoot, '.scratch', 'feat', 'state-summary.json'), JSON.stringify({
    dependencyCopyResult: 'copied node_modules',
    envTestingStatus: 'present',
    disabledTestDecision: 'none',
    smokeTestResult: 'passed',
    staticReadiness: 'ready',
    styleReadiness: 'ready',
  }));

  const plan = buildLaunchPlan(
    repoRoot,
    { id: 'exec' },
    [
      { path: path.join(repoRoot, '.scratch', 'feat', 'issues', '01.md'), feature: 'feat', issueName: '01', label: 'feat/01', executorAfk: true, status: 'done' },
      { path: path.join(repoRoot, '.scratch', 'feat', 'issues', '02.md'), feature: 'feat', issueName: '02', label: 'feat/02', executorAfk: true, status: 'ready-for-agent' },
      { path: ticketPath, feature: 'feat', issueName: '03', label: 'feat/03', executorAfk: true, status: 'ready-for-agent', dependsOn: ['01', '02'] },
    ],
    { featureSlug: 'feat', defaultWorktreeName: 'feat', effectiveWorktreeName: 'feat-tree', defaultBranchName: 'afk/feat', effectiveBranchName: 'afk/feat-tree', worktreePath: repoRoot },
  );
  const snapshot = plan.snapshots?.['feat/03'];
  assert.ok(snapshot);
  const prompt = buildPrompt({
    checkout: plan.checkout,
    ticket: plan.tickets[2]!,
    ticketContent: 'Status: ready-for-agent\n',
    snapshot,
  });

  assert.match(prompt, /## AFK State Snapshot/);
  assert.match(prompt, /Dependency tickets:/);
  assert.match(prompt, /feat\/01: ticket status=done; runtime=completed; done sentinel=present; failed sentinel=missing/);
  assert.match(prompt, /feat\/02: ticket status=ready-for-agent; runtime=failed; done sentinel=missing; failed sentinel=present/);
  assert.match(prompt, /instruction: if feat\/01 is already done, do not implement it again/);
  assert.match(prompt, /Worktree HEAD:/);
  assert.match(prompt, /Launch `git status --short`:/);
  assert.match(prompt, /Worktree readiness facts:/);
  assert.match(prompt, /dependency-copy: copied node_modules/);
  assert.match(prompt, /\.env\.testing: present/);
  assert.match(prompt, /Scope guard: exclude unrelated \.scratch content/);
  assert.doesNotMatch(prompt, /super secret scratch text/);
});
