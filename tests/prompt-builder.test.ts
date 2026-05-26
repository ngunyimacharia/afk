import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildLaunchPlan } from '../src/launch-context-builder.js';
import { buildPrompt } from '../src/prompt-builder.js';

test('prompt consumes prepared checkout context', () => {
  const prompt = buildPrompt({
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat-tree',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat-tree',
      worktreePath: '/repo/.git/worktrees/feat-tree',
    },
    ticket: {
      path: '/repo/.scratch/feat/issues/01.md',
      feature: 'feat',
      issueName: '01',
      label: 'feat/01',
      executorAfk: true,
    },
    ticketContent: '---\nstatus: ready-for-agent\n---\n',
  });
  assert.match(prompt, /Use this prepared checkout/);
  assert.match(prompt, /Working checkout: \/repo\/\.git\/worktrees\/feat-tree/);
  assert.match(prompt, /feat-tree/);
  assert.match(prompt, /Ticket file to update: \/repo\/\.scratch\/feat\/issues\/01\.md/);
  assert.match(
    prompt,
    /Do not put the final AFK summary only in the assistant response, runtime log, or commit message/,
  );
  assert.match(prompt, /status: ready-for-agent/);
  assert.doesNotMatch(prompt, /## AFK State Snapshot/);
  assert.match(prompt, /Access policy: source-code reads, searches, tests, and edits must use the Working checkout/);
  assert.match(prompt, /Root repo writes are allowed only under the listed shared \.scratch artifact paths/);
  assert.match(prompt, /Search policy: search only inside the Working checkout/);
  assert.doesNotMatch(prompt, /git worktree add|git worktree list|change into the worktree/i);
});

test('afk prompt includes budget and handoff guardrails', () => {
  const source = readFileSync(new URL('../src/prompts/afk-prompt.md', import.meta.url), 'utf8');
  assert.match(source, /Do not create fixup commits, repair disabled tests, or retry known readiness failures/);
  assert.match(source, /Append or update `## AFK Summary`/);
});

test('default execution prompt requires reviewer notes subsection', () => {
  const prompt = buildPrompt({
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/repo/.git/worktrees/feat',
    },
    ticket: {
      path: '/repo/.scratch/feat/issues/01.md',
      feature: 'feat',
      issueName: '01',
      label: 'feat/01',
      executorAfk: true,
    },
    ticketContent: '---\nstatus: ready-for-agent\n---\n',
  });
  assert.match(prompt, /### Reviewer Notes/);
  assert.match(prompt, /changes made/);
  assert.match(prompt, /tests run/);
  assert.match(prompt, /caveats or risks/);
  assert.match(prompt, /follow-ups useful to the reviewer/);
});

test('custom afk instructions do not suppress reviewer-notes requirement', () => {
  const prompt = buildPrompt({
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/repo/.git/worktrees/feat',
    },
    ticket: {
      path: '/repo/.scratch/feat/issues/01.md',
      feature: 'feat',
      issueName: '01',
      label: 'feat/01',
      executorAfk: true,
    },
    ticketContent: '---\nstatus: ready-for-agent\n---\n',
    afkInstructions: '# Custom AFK Instructions\n\nCustom rules here.\n',
  });
  assert.match(prompt, /Custom rules here/);
  assert.match(prompt, /### Reviewer Notes/);
  assert.match(prompt, /changes made/);
  assert.match(prompt, /tests run/);
  assert.match(prompt, /caveats or risks/);
  assert.match(prompt, /follow-ups useful to the reviewer/);
});

test('snapshot includes dependency/runtime/readiness facts and excludes unrelated scratch content', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-prompt-snapshot-'));
  const ticketPath = path.join(repoRoot, '.scratch', 'feat', 'issues', '03.md');
  const unrelatedScratchPath = path.join(repoRoot, '.scratch', 'other-feature', 'issues', '99.md');
  mkdirSync(path.dirname(ticketPath), { recursive: true });
  mkdirSync(path.dirname(unrelatedScratchPath), { recursive: true });
  writeFileSync(ticketPath, '---\nstatus: ready-for-agent\n---\n');
  writeFileSync(unrelatedScratchPath, 'super secret scratch text\n');
  mkdirSync(path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata'), { recursive: true });
  mkdirSync(path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'sentinels'), { recursive: true });
  writeFileSync(
    path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-01.json'),
    JSON.stringify({ STATUS: 'completed' }),
  );
  writeFileSync(
    path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-02.json'),
    JSON.stringify({ STATUS: 'failed' }),
  );
  writeFileSync(path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'sentinels', 'feat-01.done'), 'done');
  writeFileSync(path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'sentinels', 'feat-02.failed'), 'failed');
  writeFileSync(
    path.join(repoRoot, '.scratch', 'feat', 'state-summary.json'),
    JSON.stringify({
      dependencyCopyResult: 'copied node_modules',
      envTestingStatus: 'present',
      disabledTestDecision: 'none',
      smokeTestResult: 'passed',
      staticReadiness: 'ready',
      styleReadiness: 'ready',
    }),
  );
  writeFileSync(path.join(repoRoot, '.scratch', 'feat', 'PRD.md'), '# PRD\n');
  const plan = buildLaunchPlan(
    repoRoot,
    { id: 'exec' },
    [
      {
        path: path.join(repoRoot, '.scratch', 'feat', 'issues', '01.md'),
        feature: 'feat',
        issueName: '01',
        label: 'feat/01',
        executorAfk: true,
        status: 'done',
      },
      {
        path: path.join(repoRoot, '.scratch', 'feat', 'issues', '02.md'),
        feature: 'feat',
        issueName: '02',
        label: 'feat/02',
        executorAfk: true,
        status: 'ready-for-agent',
      },
      {
        path: ticketPath,
        feature: 'feat',
        issueName: '03',
        label: 'feat/03',
        executorAfk: true,
        status: 'ready-for-agent',
        dependsOn: ['01', '02'],
      },
    ],
    {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat-tree',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat-tree',
      worktreePath: repoRoot,
    },
  );
  const snapshot = plan.snapshots?.['feat/03'];
  const ticket = plan.tickets[2];
  assert.ok(snapshot);
  assert.ok(ticket);
  const prompt = buildPrompt({
    checkout: plan.checkout,
    ticket,
    ticketContent: '---\nstatus: ready-for-agent\n---\n',
    snapshot,
  });

  assert.match(prompt, /## Dependencies/);
  assert.match(prompt, /## Shared Scratch Artifacts/);
  assert.match(
    prompt,
    new RegExp(
      `Scratch feature path: ${path.join(repoRoot, '.scratch', 'feat').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    ),
  );
  assert.match(
    prompt,
    new RegExp(
      `Feature PRD: ${path.join(repoRoot, '.scratch', 'feat', 'PRD.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    ),
  );
  assert.equal(snapshot.scratchFeaturePath, path.join(repoRoot, '.scratch', 'feat'));
  assert.equal(snapshot.featurePrdPath, path.join(repoRoot, '.scratch', 'feat', 'PRD.md'));
  assert.match(
    prompt,
    /feat\/01: ticket status=done; runtime=completed; done sentinel=present; failed sentinel=missing/,
  );
  assert.match(
    prompt,
    /feat\/02: ticket status=ready-for-agent; runtime=failed; done sentinel=missing; failed sentinel=present/,
  );
  assert.match(prompt, /instruction: if feat\/01 is already done, do not implement it again/);
  assert.doesNotMatch(prompt, /Worktree HEAD:/);
  assert.doesNotMatch(prompt, /Launch `git status --short`:/);
  assert.doesNotMatch(prompt, /Worktree readiness facts:/);
  assert.doesNotMatch(prompt, /dependency-copy: copied node_modules/);
  assert.doesNotMatch(prompt, /super secret scratch text/);
});

test('snapshot includes implementation HEAD in executor prompt', () => {
  const prompt = buildPrompt({
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/repo/.git/worktrees/feat',
    },
    ticket: {
      path: '/repo/.scratch/feat/issues/01.md',
      feature: 'feat',
      issueName: '01',
      label: 'feat/01',
      executorAfk: true,
    },
    ticketContent: '---\nstatus: ready-for-agent\n---\n',
    snapshot: {
      generatedAt: '2024-01-01T00:00:00Z',
      ticketLabel: 'feat/01',
      ticketStatus: 'ready-for-agent',
      ticketIssueName: '01',
      featureSlug: 'feat',
      ticketPath: '/repo/.scratch/feat/issues/01.md',
      scratchFeaturePath: '/repo/.scratch/feat',
      featurePrdPath: '/repo/.scratch/feat/PRD.md',
      repoRoot: '/repo',
      worktreePath: '/repo/.git/worktrees/feat',
      worktreeName: 'feat',
      branchName: 'feat',
      head: 'abc123def456',
      gitStatusShort: [],
      ticketOutsideWorktree: true,
      dependencies: [],
      readiness: null,
    },
  });
  assert.match(prompt, /Implementation HEAD: abc123def456/);
  assert.match(prompt, /Repo root.*: \/repo/);
  assert.match(prompt, /Scratch feature path: \/repo\/\.scratch\/feat/);
  assert.match(prompt, /Feature PRD: \/repo\/\.scratch\/feat\/PRD\.md/);
});

test('launch plan snapshots use per-feature checkouts', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-prompt-multi-checkout-'));
  const ticketA = path.join(repoRoot, '.scratch', 'feat-a', 'issues', '01.md');
  const ticketB = path.join(repoRoot, '.scratch', 'feat-b', 'issues', '01.md');
  mkdirSync(path.dirname(ticketA), { recursive: true });
  mkdirSync(path.dirname(ticketB), { recursive: true });
  writeFileSync(ticketA, '---\nstatus: ready-for-agent\n---\n');
  writeFileSync(ticketB, '---\nstatus: ready-for-agent\n---\n');
  const checkoutA = {
    featureSlug: 'feat-a',
    defaultWorktreeName: 'feat-a',
    effectiveWorktreeName: 'tree-a',
    defaultBranchName: 'feat-a',
    effectiveBranchName: 'feat-a',
    worktreePath: path.join(repoRoot, '.worktree', 'tree-a'),
  };
  const checkoutB = {
    featureSlug: 'feat-b',
    defaultWorktreeName: 'feat-b',
    effectiveWorktreeName: 'tree-b',
    defaultBranchName: 'feat-b',
    effectiveBranchName: 'feat-b',
    worktreePath: path.join(repoRoot, '.worktree', 'tree-b'),
  };

  const plan = buildLaunchPlan(
    repoRoot,
    { id: 'exec' },
    [
      { path: ticketA, feature: 'feat-a', issueName: '01', label: 'feat-a/01', executorAfk: true },
      { path: ticketB, feature: 'feat-b', issueName: '01', label: 'feat-b/01', executorAfk: true },
    ],
    checkoutA,
    undefined,
    { 'feat-a': checkoutA, 'feat-b': checkoutB },
  );

  assert.equal(plan.gitContext.commits.length, 0);
  assert.equal(plan.snapshots?.['feat-a/01']?.worktreeName, 'tree-a');
  assert.equal(plan.snapshots?.['feat-b/01']?.worktreeName, 'tree-b');
  assert.equal(plan.snapshots?.['feat-b/01']?.worktreePath, path.resolve(checkoutB.worktreePath));
});
