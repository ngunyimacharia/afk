import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RuntimeStore } from '../src/runtime-store.js';
import { Scheduler } from '../src/scheduler.js';
import type { LaunchPlan } from '../src/types.js';

test('starts ready tickets without feature serialization', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-scheduler-runtime-'));
  const store = new RuntimeStore({ repoRoot });
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
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
      { path: '/tmp/a-2.md', feature: 'feat-a', issueName: '002', label: 'feat-a/002', executorAfk: true },
      { path: '/tmp/b-1.md', feature: 'feat-b', issueName: '001', label: 'feat-b/001', executorAfk: true },
    ],
    gitContext: { commits: [] },
    checkout: { featureSlug: 'feat-a', defaultWorktreeName: 'feat-a', effectiveWorktreeName: 'feat-a', defaultBranchName: 'afk/feat-a', effectiveBranchName: 'afk/feat-a', worktreePath: '/tmp/worktree' },
  };

  const result = await scheduler.launch(plan as never);
  assert.equal(result.scheduled, true);
  assert.deepEqual(started, ['feat-a/001', 'feat-a/002', 'feat-b/001']);
  void store;
});
