import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FakeAgentExecutionProvider } from '../src/agent-execution-provider.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { SingleTicketRunner } from '../src/single-ticket-runner.js';
import { Scheduler } from '../src/scheduler.js';

test('launches one ticket and writes runtime artifacts before exit', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-'));
  const store = new RuntimeStore({ repoRoot });
  const runner = new SingleTicketRunner(store, new FakeAgentExecutionProvider({ status: 'completed', sessionId: 'session-1', removable: true, output: ['worker started'] }));
  const plan = { repoRoot, model: { id: 'model-1' }, tickets: [{ path: '/tmp/ticket.md', feature: 'feat', issueName: '001', label: 'feat/001', executorAfk: true }], gitContext: { commits: [] }, checkout: { featureSlug: 'feat', defaultWorktreeName: 'feat', effectiveWorktreeName: 'feat', defaultBranchName: 'afk/feat', effectiveBranchName: 'afk/feat', worktreePath: '/tmp/worktree' } };
  const result = await runner.launch(plan as never);
  assert.equal(result.scheduled, true);
  assert.match(result.message, /Scheduled feat\/001/);
  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-001.json');
  const logPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-001.log');
  assert.match(readFileSync(metadataPath, 'utf8'), /session-1/);
  assert.match(readFileSync(logPath, 'utf8'), /ticket start: feat\/001/);
  assert.match(readFileSync(logPath, 'utf8'), /worker started/);
});

test('records failed state when the provider throws', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-fail-'));
  const store = new RuntimeStore({ repoRoot });
  const runner = new SingleTicketRunner(store, { execute: async () => { throw new Error('boom'); } });
  const plan = { repoRoot, model: { id: 'model-1' }, tickets: [{ path: '/tmp/ticket.md', feature: 'feat', issueName: '002', label: 'feat/002', executorAfk: true }], gitContext: { commits: [] }, checkout: { featureSlug: 'feat', defaultWorktreeName: 'feat', effectiveWorktreeName: 'feat', defaultBranchName: 'afk/feat', effectiveBranchName: 'afk/feat', worktreePath: '/tmp/worktree' } };
  const result = await runner.launch(plan as never);
  assert.equal(result.scheduled, true);
  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-002.json');
  assert.match(readFileSync(metadataPath, 'utf8'), /"STATUS": "failed"/);
});

test('scheduler queues tickets by feature and starts the next queued ticket after completion', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-scheduler-'));
  const store = new RuntimeStore({ repoRoot });
  const started: string[] = [];
  const runner = new SingleTicketRunner(store, { execute: async ({ plan }) => {
    const ticket = plan.tickets[0];
    started.push(ticket.label);
    return { status: 'completed', sessionId: ticket.label, removable: true };
  } });
  const scheduler = new Scheduler(runner);
  const plan = { repoRoot, model: { id: 'model-1' }, tickets: [
    { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
    { path: '/tmp/b-1.md', feature: 'feat-b', issueName: '001', label: 'feat-b/001', executorAfk: true },
    { path: '/tmp/a-2.md', feature: 'feat-a', issueName: '002', label: 'feat-a/002', executorAfk: true },
  ], gitContext: { commits: [] }, checkout: { featureSlug: 'feat-a', defaultWorktreeName: 'feat-a', effectiveWorktreeName: 'feat-a', defaultBranchName: 'afk/feat-a', effectiveBranchName: 'afk/feat-a', worktreePath: '/tmp/worktree' } };

  await scheduler.launch(plan as never);
  assert.deepEqual(started, ['feat-a/001', 'feat-b/001', 'feat-a/002']);
});
