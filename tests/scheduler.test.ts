import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RuntimeStore } from '../src/runtime-store.js';
import { Scheduler } from '../src/scheduler.js';
import type { LaunchPlan } from '../src/types.js';

test('runs ready tickets in parallel and caps global concurrency', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-scheduler-'));
  const store = new RuntimeStore({ repoRoot });
  const active = new Set<string>();
  let peak = 0;
  const launches: string[] = [];

  const scheduler = new Scheduler({
    launch: async (plan: LaunchPlan) => {
      const ticket = plan.tickets[0];
      assert.ok(ticket);
      active.add(ticket.label);
      peak = Math.max(peak, active.size);
      launches.push(ticket.label);
      await new Promise((resolve) => setTimeout(resolve, ticket.feature === 'feat-a' ? 20 : 5));
      active.delete(ticket.label);
      return { scheduled: true, message: ticket.label };
    },
  } as never);

  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'reviewer-model-1' },
    reviewerPrompt: { id: 'reviewer-default', path: '/tmp/reviewer-default.md' },
    tickets: [
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
      { path: '/tmp/b-1.md', feature: 'feat-b', issueName: '001', label: 'feat-b/001', executorAfk: true },
      { path: '/tmp/c-1.md', feature: 'feat-c', issueName: '001', label: 'feat-c/001', executorAfk: true },
      { path: '/tmp/a-2.md', feature: 'feat-a', issueName: '002', label: 'feat-a/002', executorAfk: true },
      { path: '/tmp/b-2.md', feature: 'feat-b', issueName: '002', label: 'feat-b/002', executorAfk: true },
    ],
    gitContext: { commits: [] },
    checkout: { featureSlug: 'feat-a', defaultWorktreeName: 'feat-a', effectiveWorktreeName: 'feat-a', defaultBranchName: 'afk/feat-a', effectiveBranchName: 'afk/feat-a', worktreePath: '/tmp/worktree' },
  };

  const result = await scheduler.launch(plan as never);
  assert.equal(result.scheduled, true);
  assert.equal(peak <= 3, true);
  assert.equal(launches[0], 'feat-a/001');
  assert.equal(launches[1], 'feat-b/001');
  assert.equal(launches[2], 'feat-c/001');
  assert.equal(launches.includes('feat-a/002'), true);
  assert.equal(launches.includes('feat-b/002'), true);
  void store;
});

test('continues independent queues when one ticket fails', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-scheduler-fail-'));
  const scheduler = new Scheduler({
    launch: async (plan: LaunchPlan) => {
      const ticket = plan.tickets[0];
      assert.ok(ticket);
      if (ticket.feature === 'feat-a' && ticket.issueName === '001') throw new Error('boom');
      return { scheduled: true, message: ticket.label };
    },
  } as never);

  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'reviewer-model-1' },
    reviewerPrompt: { id: 'reviewer-default', path: '/tmp/reviewer-default.md' },
    tickets: [
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
      { path: '/tmp/b-1.md', feature: 'feat-b', issueName: '001', label: 'feat-b/001', executorAfk: true },
    ],
    gitContext: { commits: [] },
    checkout: { featureSlug: 'feat-a', defaultWorktreeName: 'feat-a', effectiveWorktreeName: 'feat-a', defaultBranchName: 'afk/feat-a', effectiveBranchName: 'afk/feat-a', worktreePath: '/tmp/worktree' },
  };

  const result = await scheduler.launch(plan as never);
  assert.equal(result.scheduled, true);
  assert.match(result.message, /boom/);
});

test('waits for dependency completion before launching dependent ticket', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-scheduler-deps-'));
  const started: string[] = [];
  const scheduler = new Scheduler({
    launch: async (plan: LaunchPlan) => {
      const ticket = plan.tickets[0];
      assert.ok(ticket);
      started.push(ticket.label);
      return { scheduled: true, message: ticket.label };
    },
  } as never);

  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'reviewer-model-1' },
    reviewerPrompt: { id: 'reviewer-default', path: '/tmp/reviewer-default.md' },
    tickets: [
      { path: '/tmp/a-2.md', feature: 'feat-a', issueName: '002', label: 'feat-a/002', executorAfk: true, dependsOn: ['001'] },
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
    ],
    gitContext: { commits: [] },
    checkout: { featureSlug: 'feat-a', defaultWorktreeName: 'feat-a', effectiveWorktreeName: 'feat-a', defaultBranchName: 'afk/feat-a', effectiveBranchName: 'afk/feat-a', worktreePath: '/tmp/worktree' },
  };

  const result = await scheduler.launch(plan as never);
  assert.equal(result.scheduled, true);
  assert.deepEqual(started, ['feat-a/001', 'feat-a/002']);
});

test('returns structured launch-block evidence for invalid selected paths', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-scheduler-launch-block-'));
  const scheduler = new Scheduler({
    launch: async () => ({
      scheduled: false,
      message: 'Invalid selected issue path for feat-a/001',
      launchBlock: {
        kind: 'path-validation',
        message: 'Invalid selected issue path for feat-a/001',
        ticketLabel: 'feat-a/001',
        feature: 'feat-a',
        issueName: '001',
        path: '/tmp/invalid.md',
      },
    }),
  } as never);

  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    tickets: [
      { path: '/tmp/invalid.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
    ],
    gitContext: { commits: [] },
    checkout: { featureSlug: 'feat-a', defaultWorktreeName: 'feat-a', effectiveWorktreeName: 'feat-a', defaultBranchName: 'afk/feat-a', effectiveBranchName: 'afk/feat-a', worktreePath: '/tmp/worktree' },
  };

  const result = await scheduler.launch(plan as never);
  assert.equal(result.scheduled, true);
  assert.equal(result.launchBlocks?.[0]?.kind, 'path-validation');
  assert.equal(result.launchBlocks?.[0]?.ticketLabel, 'feat-a/001');
});

test('passes feature checkout and matching snapshot to runner', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-scheduler-checkout-'));
  const seen: string[] = [];
  const scheduler = new Scheduler({
    launch: async (plan: LaunchPlan) => {
      const ticket = plan.tickets[0];
      assert.ok(ticket);
      seen.push(`${ticket.label}:${plan.checkout.worktreePath}:${plan.snapshots?.[ticket.label]?.worktreePath}`);
      return { scheduled: true, message: ticket.label };
    },
  } as never, 1);

  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    tickets: [
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
      { path: '/tmp/b-1.md', feature: 'feat-b', issueName: '001', label: 'feat-b/001', executorAfk: true },
    ],
    gitContext: { commits: [] },
    checkout: { featureSlug: 'feat-a', defaultWorktreeName: 'feat-a', effectiveWorktreeName: 'feat-a', defaultBranchName: 'afk/feat-a', effectiveBranchName: 'afk/feat-a', worktreePath: '/tmp/tree-a' },
    checkouts: {
      'feat-a': { featureSlug: 'feat-a', defaultWorktreeName: 'feat-a', effectiveWorktreeName: 'feat-a', defaultBranchName: 'afk/feat-a', effectiveBranchName: 'afk/feat-a', worktreePath: '/tmp/tree-a' },
      'feat-b': { featureSlug: 'feat-b', defaultWorktreeName: 'feat-b', effectiveWorktreeName: 'feat-b', defaultBranchName: 'afk/feat-b', effectiveBranchName: 'afk/feat-b', worktreePath: '/tmp/tree-b' },
    },
    snapshots: {
      'feat-a/001': { featureSlug: 'feat-a', worktreePath: '/tmp/tree-a' },
      'feat-b/001': { featureSlug: 'feat-b', worktreePath: '/tmp/tree-b' },
    },
  };

  await scheduler.launch(plan as never);

  assert.deepEqual(seen, [
    'feat-a/001:/tmp/tree-a:/tmp/tree-a',
    'feat-b/001:/tmp/tree-b:/tmp/tree-b',
  ]);
});
