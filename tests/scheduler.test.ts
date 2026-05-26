import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RuntimeStore } from '../src/runtime-store.js';
import { type FeatureLockProvider, type FeatureMergeBackProvider, Scheduler } from '../src/scheduler.js';
import type { LaunchPlan, TicketRecord } from '../src/types.js';

function createMockScratchWorktreeService() {
  return {
    createScratchWorktree: (input: { repoRoot: string; featureSlug: string; issueName: string; baseRef?: string }) => ({
      featureSlug: input.featureSlug,
      defaultWorktreeName: `${input.featureSlug}-${input.issueName}`,
      effectiveWorktreeName: `${input.featureSlug}-${input.issueName}`,
      defaultBranchName: `afk/${input.featureSlug}/${input.issueName}`,
      effectiveBranchName: `afk/${input.featureSlug}/${input.issueName}`,
      worktreePath: `/scratch/${input.featureSlug}-${input.issueName}`,
    }),
    removeScratchWorktree: () => {},
  };
}

const defaultMergeBackProvider: FeatureMergeBackProvider = {
  isWaveMerged: () => true,
};

function createScheduler(
  runner: {
    launch: (
      plan: LaunchPlan,
    ) => Promise<{ scheduled: boolean; message: string; outcome?: string; launchBlock?: unknown }>;
  },
  options?: {
    featureLockProvider?: FeatureLockProvider;
    featureMergeBackProvider?: FeatureMergeBackProvider;
    concurrencyLimit?: number;
  },
) {
  return new Scheduler({
    runner: runner as never,
    scratchWorktreeService: createMockScratchWorktreeService() as never,
    featureLockProvider: options?.featureLockProvider,
    featureMergeBackProvider: options?.featureMergeBackProvider ?? defaultMergeBackProvider,
    concurrencyLimit: options?.concurrencyLimit,
  });
}

function basePlan(overrides: Partial<LaunchPlan> & { tickets: TicketRecord[] }): LaunchPlan {
  return {
    repoRoot: mkdtempSync(path.join(tmpdir(), 'afk-scheduler-')),
    model: { id: 'model-1' },
    reviewerModel: { id: 'reviewer-model-1' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: '/tmp/reviewer-default.md' },
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat-a',
      defaultWorktreeName: 'feat-a',
      effectiveWorktreeName: 'feat-a',
      defaultBranchName: 'feat-a',
      effectiveBranchName: 'feat-a',
      worktreePath: '/tmp/worktree',
    },
    ...overrides,
  };
}

test('runs ready tickets in parallel and caps global concurrency', async () => {
  const active = new Set<string>();
  let peak = 0;
  const launches: string[] = [];

  const scheduler = createScheduler({
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
  });

  const plan = basePlan({
    tickets: [
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
      { path: '/tmp/b-1.md', feature: 'feat-b', issueName: '001', label: 'feat-b/001', executorAfk: true },
      { path: '/tmp/c-1.md', feature: 'feat-c', issueName: '001', label: 'feat-c/001', executorAfk: true },
      { path: '/tmp/a-2.md', feature: 'feat-a', issueName: '002', label: 'feat-a/002', executorAfk: true },
      { path: '/tmp/b-2.md', feature: 'feat-b', issueName: '002', label: 'feat-b/002', executorAfk: true },
    ],
  });

  const result = await scheduler.launch(plan as never);
  assert.equal(result.scheduled, true);
  assert.equal(peak <= 3, true);
  assert.deepEqual(result.ticketResults.map((entry) => entry.outcome).sort(), [
    'completed',
    'completed',
    'completed',
    'completed',
    'completed',
  ]);
  assert.equal(launches[0], 'feat-a/001');
  assert.equal(launches[1], 'feat-b/001');
  assert.equal(launches[2], 'feat-c/001');
  assert.equal(launches.includes('feat-a/002'), true);
  assert.equal(launches.includes('feat-b/002'), true);
});

test('continues independent queues when one ticket fails', async () => {
  const scheduler = createScheduler({
    launch: async (plan: LaunchPlan) => {
      const ticket = plan.tickets[0];
      assert.ok(ticket);
      if (ticket.feature === 'feat-a' && ticket.issueName === '001') throw new Error('boom');
      return { scheduled: true, message: ticket.label };
    },
  });

  const plan = basePlan({
    tickets: [
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
      { path: '/tmp/b-1.md', feature: 'feat-b', issueName: '001', label: 'feat-b/001', executorAfk: true },
    ],
  });

  const result = await scheduler.launch(plan as never);
  assert.equal(result.scheduled, true);
  assert.match(result.message, /boom/);
  assert.equal(result.ticketResults.find((entry) => entry.ticket.label === 'feat-a/001')?.outcome, 'failed');
});

test('waits for dependency completion before launching dependent ticket', async () => {
  const started: string[] = [];
  const scheduler = createScheduler({
    launch: async (plan: LaunchPlan) => {
      const ticket = plan.tickets[0];
      assert.ok(ticket);
      started.push(ticket.label);
      return { scheduled: true, message: ticket.label };
    },
  });

  const plan = basePlan({
    tickets: [
      {
        path: '/tmp/a-2.md',
        feature: 'feat-a',
        issueName: '002',
        label: 'feat-a/002',
        executorAfk: true,
        dependsOn: ['001'],
      },
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
    ],
  });

  const result = await scheduler.launch(plan as never);
  assert.equal(result.scheduled, true);
  assert.deepEqual(started, ['feat-a/001', 'feat-a/002']);
});

test('treats unselected dependencies as already validated by launch selection', async () => {
  const started: string[] = [];
  const scheduler = createScheduler({
    launch: async (plan: LaunchPlan) => {
      const ticket = plan.tickets[0];
      assert.ok(ticket);
      started.push(ticket.label);
      return { scheduled: true, message: ticket.label };
    },
  });

  const plan = basePlan({
    tickets: [
      {
        path: '/tmp/a-2.md',
        feature: 'feat-a',
        issueName: '002',
        label: 'feat-a/002',
        executorAfk: true,
        dependsOn: ['001'],
      },
    ],
  });

  const result = await scheduler.launch(plan as never);

  assert.equal(result.scheduled, true);
  assert.deepEqual(started, ['feat-a/002']);
  assert.equal(result.ticketResults[0]?.outcome, 'completed');
});

test('skips completed tickets and marks them completed in scheduler results', async () => {
  const started: string[] = [];
  const scheduler = createScheduler({
    launch: async (plan: LaunchPlan) => {
      const ticket = plan.tickets[0];
      assert.ok(ticket);
      started.push(ticket.label);
      return { scheduled: true, message: ticket.label };
    },
  });

  const plan = basePlan({
    tickets: [
      {
        path: '/tmp/a-1.md',
        feature: 'feat-a',
        issueName: '001',
        label: 'feat-a/001',
        status: 'done',
        executorAfk: true,
      },
      {
        path: '/tmp/a-2.md',
        feature: 'feat-a',
        issueName: '002',
        label: 'feat-a/002',
        status: 'ready-for-agent',
        executorAfk: true,
        dependsOn: ['001'],
      },
    ],
  });

  const result = await scheduler.launch(plan as never);

  assert.deepEqual(started, ['feat-a/002']);
  assert.equal(
    result.ticketResults.find((entry) => entry.ticket.label === 'feat-a/001')?.message,
    'Skipped feat-a/001: ticket already done',
  );
  assert.equal(result.ticketResults.find((entry) => entry.ticket.label === 'feat-a/002')?.outcome, 'completed');
});

test('does not launch dependent ticket when dependency blocks', async () => {
  const started: string[] = [];
  const scheduler = createScheduler({
    launch: async (plan: LaunchPlan) => {
      const ticket = plan.tickets[0];
      assert.ok(ticket);
      started.push(ticket.label);
      return ticket.issueName === '001'
        ? { scheduled: true, message: ticket.label, outcome: 'blocked' }
        : { scheduled: true, message: ticket.label, outcome: 'completed' };
    },
  });

  const plan = basePlan({
    tickets: [
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
      {
        path: '/tmp/a-2.md',
        feature: 'feat-a',
        issueName: '002',
        label: 'feat-a/002',
        executorAfk: true,
        dependsOn: ['001'],
      },
    ],
  });

  const result = await scheduler.launch(plan as never);

  assert.equal(result.scheduled, true);
  assert.match(result.message, /dependencies did not complete/);
  assert.deepEqual(started, ['feat-a/001']);
  assert.equal(result.ticketResults.find((entry) => entry.ticket.label === 'feat-a/002')?.outcome, 'not-scheduled');
});

test('allows same-feature tickets without dependencies to run concurrently', async () => {
  const active = new Set<string>();
  let peak = 0;
  const launches: string[] = [];
  const scheduler = createScheduler(
    {
      launch: async (plan: LaunchPlan) => {
        const ticket = plan.tickets[0];
        assert.ok(ticket);
        active.add(ticket.label);
        peak = Math.max(peak, active.size);
        launches.push(ticket.label);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active.delete(ticket.label);
        return { scheduled: true, message: ticket.label };
      },
    },
    { concurrencyLimit: 3 },
  );

  const plan = basePlan({
    tickets: [
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
      { path: '/tmp/a-2.md', feature: 'feat-a', issueName: '002', label: 'feat-a/002', executorAfk: true },
      { path: '/tmp/b-1.md', feature: 'feat-b', issueName: '001', label: 'feat-b/001', executorAfk: true },
    ],
  });

  await scheduler.launch(plan as never);

  assert.equal(peak, 3);
  assert.equal(launches.includes('feat-a/001'), true);
  assert.equal(launches.includes('feat-a/002'), true);
  assert.equal(launches.includes('feat-b/001'), true);
});

test('returns structured launch-block evidence for invalid selected paths', async () => {
  const scheduler = createScheduler({
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
  });

  const plan = basePlan({
    tickets: [{ path: '/tmp/invalid.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true }],
  });

  const result = await scheduler.launch(plan as never);
  assert.equal(result.scheduled, true);
  assert.equal(result.launchBlocks?.[0]?.kind, 'path-validation');
  assert.equal(result.launchBlocks?.[0]?.ticketLabel, 'feat-a/001');
});

test('passes scratch worktree checkout and all scratch worktrees in checkouts to runner', async () => {
  const seen: { label: string; checkoutPath: string; checkoutsPaths: string[] }[] = [];
  const scheduler = createScheduler(
    {
      launch: async (plan: LaunchPlan) => {
        const ticket = plan.tickets[0];
        assert.ok(ticket);
        seen.push({
          label: ticket.label,
          checkoutPath: plan.checkout.worktreePath,
          checkoutsPaths: Object.values(plan.checkouts ?? {}).map((c) => c.worktreePath),
        });
        return { scheduled: true, message: ticket.label };
      },
    },
    { concurrencyLimit: 1 },
  );

  const plan = basePlan({
    tickets: [
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
      { path: '/tmp/b-1.md', feature: 'feat-b', issueName: '001', label: 'feat-b/001', executorAfk: true },
    ],
    checkouts: {
      'feat-a': {
        featureSlug: 'feat-a',
        defaultWorktreeName: 'feat-a',
        effectiveWorktreeName: 'feat-a',
        defaultBranchName: 'feat-a',
        effectiveBranchName: 'feat-a',
        worktreePath: '/tmp/tree-a',
      },
      'feat-b': {
        featureSlug: 'feat-b',
        defaultWorktreeName: 'feat-b',
        effectiveWorktreeName: 'feat-b',
        defaultBranchName: 'feat-b',
        effectiveBranchName: 'feat-b',
        worktreePath: '/tmp/tree-b',
      },
    },
  });

  await scheduler.launch(plan as never);

  const first = seen.find((s) => s.label === 'feat-a/001');
  const second = seen.find((s) => s.label === 'feat-b/001');
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.checkoutPath, '/scratch/feat-a-001');
  assert.equal(second.checkoutPath, '/scratch/feat-b-001');
  assert.equal(first.checkoutsPaths.includes('/tmp/tree-a'), true);
  assert.equal(first.checkoutsPaths.includes('/scratch/feat-a-001'), true);
  assert.equal(second.checkoutsPaths.includes('/tmp/tree-b'), true);
  assert.equal(second.checkoutsPaths.includes('/scratch/feat-b-001'), true);
});

test('waits for upstream feature completion before launching downstream feature tickets', async () => {
  const started: string[] = [];
  const scheduler = createScheduler(
    {
      launch: async (plan: LaunchPlan) => {
        const ticket = plan.tickets[0];
        assert.ok(ticket);
        started.push(ticket.label);
        await new Promise((resolve) => setTimeout(resolve, ticket.feature === 'feat-a' ? 20 : 1));
        return { scheduled: true, message: ticket.label };
      },
    },
    { concurrencyLimit: 3 },
  );

  const plan = basePlan({
    tickets: [
      { path: '/tmp/b-1.md', feature: 'feat-b', issueName: '001', label: 'feat-b/001', executorAfk: true },
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
    ],
    featureDependencies: { 'feat-b': ['feat-a'] },
  });

  const result = await scheduler.launch(plan as never);
  assert.equal(result.scheduled, true);
  assert.deepEqual(started, ['feat-a/001', 'feat-b/001']);
});

test('allows independent features to run concurrently', async () => {
  const active = new Set<string>();
  let peak = 0;
  const scheduler = createScheduler(
    {
      launch: async (plan: LaunchPlan) => {
        const ticket = plan.tickets[0];
        assert.ok(ticket);
        active.add(ticket.label);
        peak = Math.max(peak, active.size);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active.delete(ticket.label);
        return { scheduled: true, message: ticket.label };
      },
    },
    { concurrencyLimit: 3 },
  );

  const plan = basePlan({
    tickets: [
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
      { path: '/tmp/b-1.md', feature: 'feat-b', issueName: '001', label: 'feat-b/001', executorAfk: true },
    ],
    featureDependencies: {},
  });

  const result = await scheduler.launch(plan as never);
  assert.equal(result.scheduled, true);
  assert.equal(peak, 2);
});

test('does not block on unselected complete upstream features', async () => {
  const started: string[] = [];
  const scheduler = createScheduler(
    {
      launch: async (plan: LaunchPlan) => {
        const ticket = plan.tickets[0];
        assert.ok(ticket);
        started.push(ticket.label);
        return { scheduled: true, message: ticket.label };
      },
    },
    { concurrencyLimit: 3 },
  );

  const plan = basePlan({
    tickets: [{ path: '/tmp/b-1.md', feature: 'feat-b', issueName: '001', label: 'feat-b/001', executorAfk: true }],
    featureDependencies: { 'feat-b': ['feat-a'] },
  });

  const result = await scheduler.launch(plan as never);
  assert.equal(result.scheduled, true);
  assert.deepEqual(started, ['feat-b/001']);
  assert.equal(result.ticketResults[0]?.outcome, 'completed');
});

test('serializes same-feature tickets across wave boundaries', async () => {
  const started: string[] = [];
  const scheduler = createScheduler({
    launch: async (plan: LaunchPlan) => {
      const ticket = plan.tickets[0];
      assert.ok(ticket);
      started.push(ticket.label);
      return { scheduled: true, message: ticket.label };
    },
  });

  const plan = basePlan({
    tickets: [
      {
        path: '/tmp/a-3.md',
        feature: 'feat-a',
        issueName: '003',
        label: 'feat-a/003',
        executorAfk: true,
        dependsOn: ['002'],
      },
      {
        path: '/tmp/a-2.md',
        feature: 'feat-a',
        issueName: '002',
        label: 'feat-a/002',
        executorAfk: true,
        dependsOn: ['001'],
      },
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
    ],
  });

  const result = await scheduler.launch(plan as never);
  assert.equal(result.scheduled, true);
  assert.deepEqual(started, ['feat-a/001', 'feat-a/002', 'feat-a/003']);
});

test('blocks later waves when any ticket in an earlier wave fails', async () => {
  const started: string[] = [];
  const scheduler = createScheduler({
    launch: async (plan: LaunchPlan) => {
      const ticket = plan.tickets[0];
      assert.ok(ticket);
      started.push(ticket.label);
      if (ticket.issueName === '002') throw new Error('wave-0-failure');
      return { scheduled: true, message: ticket.label };
    },
  });

  const plan = basePlan({
    tickets: [
      {
        path: '/tmp/a-3.md',
        feature: 'feat-a',
        issueName: '003',
        label: 'feat-a/003',
        executorAfk: true,
        dependsOn: ['002'],
      },
      { path: '/tmp/a-2.md', feature: 'feat-a', issueName: '002', label: 'feat-a/002', executorAfk: true },
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
    ],
  });

  const result = await scheduler.launch(plan as never);
  assert.equal(result.scheduled, true);
  // Wave 0 tickets run concurrently, so order is non-deterministic
  assert.equal(started.includes('feat-a/001'), true);
  assert.equal(started.includes('feat-a/002'), true);
  assert.equal(started.includes('feat-a/003'), false);
  assert.equal(result.ticketResults.find((r) => r.ticket.label === 'feat-a/003')?.outcome, 'not-scheduled');
});

test('does not launch tickets for a locked feature', async () => {
  const started: string[] = [];
  const lockProvider: FeatureLockProvider = {
    isLocked: (feature: string) => feature === 'feat-a',
  };
  const scheduler = createScheduler(
    {
      launch: async (plan: LaunchPlan) => {
        const ticket = plan.tickets[0];
        assert.ok(ticket);
        started.push(ticket.label);
        return { scheduled: true, message: ticket.label };
      },
    },
    { featureLockProvider: lockProvider, concurrencyLimit: 3 },
  );

  const plan = basePlan({
    tickets: [
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
      { path: '/tmp/b-1.md', feature: 'feat-b', issueName: '001', label: 'feat-b/001', executorAfk: true },
    ],
  });

  const result = await scheduler.launch(plan as never);
  assert.equal(result.scheduled, true);
  assert.deepEqual(started, ['feat-b/001']);
  assert.equal(result.ticketResults.find((r) => r.ticket.label === 'feat-a/001')?.outcome, 'not-scheduled');
});

test('wave-by-wave execution with parallel tickets in the same wave', async () => {
  const started: string[] = [];
  const scheduler = createScheduler(
    {
      launch: async (plan: LaunchPlan) => {
        const ticket = plan.tickets[0];
        assert.ok(ticket);
        started.push(ticket.label);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { scheduled: true, message: ticket.label };
      },
    },
    { concurrencyLimit: 3 },
  );

  const plan = basePlan({
    tickets: [
      {
        path: '/tmp/a-3.md',
        feature: 'feat-a',
        issueName: '003',
        label: 'feat-a/003',
        executorAfk: true,
        dependsOn: ['001', '002'],
      },
      { path: '/tmp/a-2.md', feature: 'feat-a', issueName: '002', label: 'feat-a/002', executorAfk: true },
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
    ],
  });

  const result = await scheduler.launch(plan as never);
  assert.equal(result.scheduled, true);
  // Wave 0: 001 and 002 can run in any order (parallel)
  assert.equal(started.indexOf('feat-a/003') > started.indexOf('feat-a/001'), true);
  assert.equal(started.indexOf('feat-a/003') > started.indexOf('feat-a/002'), true);
  assert.equal(
    result.ticketResults.every((r) => r.outcome === 'completed'),
    true,
  );
});

test('blocks later waves when previous wave is not merged back', async () => {
  const started: string[] = [];
  const mergeBackProvider: FeatureMergeBackProvider = {
    isWaveMerged: () => false,
  };
  const scheduler = createScheduler(
    {
      launch: async (plan: LaunchPlan) => {
        const ticket = plan.tickets[0];
        assert.ok(ticket);
        started.push(ticket.label);
        return { scheduled: true, message: ticket.label };
      },
    },
    { featureMergeBackProvider: mergeBackProvider, concurrencyLimit: 3 },
  );

  const plan = basePlan({
    tickets: [
      {
        path: '/tmp/a-2.md',
        feature: 'feat-a',
        issueName: '002',
        label: 'feat-a/002',
        executorAfk: true,
        dependsOn: ['001'],
      },
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
    ],
  });

  const result = await scheduler.launch(plan as never);
  assert.equal(result.scheduled, true);
  assert.deepEqual(started, ['feat-a/001']);
  assert.equal(result.ticketResults.find((r) => r.ticket.label === 'feat-a/002')?.outcome, 'not-scheduled');
});

test('allows later waves to proceed when merge-back completes after wave ticket finishes', async () => {
  const started: string[] = [];
  let callCount = 0;
  const mergeBackProvider: FeatureMergeBackProvider = {
    isWaveMerged: () => {
      callCount++;
      // First call is during the completion handler (merge not yet done)
      // Second call is during isReady re-check (merge now done)
      return callCount >= 2;
    },
  };
  const scheduler = createScheduler(
    {
      launch: async (plan: LaunchPlan) => {
        const ticket = plan.tickets[0];
        assert.ok(ticket);
        started.push(ticket.label);
        return { scheduled: true, message: ticket.label };
      },
    },
    { featureMergeBackProvider: mergeBackProvider, concurrencyLimit: 1 },
  );

  const plan = basePlan({
    tickets: [
      {
        path: '/tmp/a-2.md',
        feature: 'feat-a',
        issueName: '002',
        label: 'feat-a/002',
        executorAfk: true,
        dependsOn: ['001'],
      },
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
    ],
  });

  const result = await scheduler.launch(plan as never);
  assert.equal(result.scheduled, true);
  assert.deepEqual(started, ['feat-a/001', 'feat-a/002']);
  assert.equal(result.ticketResults.every((r) => r.outcome === 'completed'), true);
});
