import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FakeAgentExecutionProvider } from '../src/agent-execution-provider.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { SingleTicketRunner } from '../src/single-ticket-runner.js';

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
