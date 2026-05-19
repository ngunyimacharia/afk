import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FakeAgentExecutionProvider } from '../src/agent-execution-provider.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { SingleTicketRunner } from '../src/single-ticket-runner.js';
import { Scheduler } from '../src/scheduler.js';
import { resolveReviewerPromptTemplate } from '../src/reviewer-prompt-catalog.js';

test('launches one ticket and writes runtime artifacts before exit', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-'));
  const store = new RuntimeStore({ repoRoot });
  const runner = new SingleTicketRunner(store, new FakeAgentExecutionProvider({ status: 'completed', sessionId: 'session-1', removable: true, output: ['worker started'] }));
  const plan = { repoRoot, model: { id: 'model-1' }, reviewerModel: { id: 'review-model' }, reviewerPrompt: resolveReviewerPromptTemplate(), tickets: [{ path: '/tmp/ticket.md', feature: 'feat', issueName: '001', label: 'feat/001', executorAfk: true }], gitContext: { commits: [] }, checkout: { featureSlug: 'feat', defaultWorktreeName: 'feat', effectiveWorktreeName: 'feat', defaultBranchName: 'afk/feat', effectiveBranchName: 'afk/feat', worktreePath: '/tmp/worktree' } };
  const result = await runner.launch(plan as never);
  assert.equal(result.scheduled, true);
  assert.match(result.message, /Scheduled feat\/001/);
  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-001.json');
  const logPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-001.log');
  assert.match(readFileSync(metadataPath, 'utf8'), /session-1/);
  assert.match(readFileSync(logPath, 'utf8'), /ticket start: feat\/001/);
  assert.match(readFileSync(logPath, 'utf8'), /worker started/);
  assert.match(readFileSync(logPath, 'utf8'), /reviewer model: review-model/);
});

test('emits progress while launching a ticket', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-progress-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, '---\nfeature: feat\n---\n\n## AFK Summary\nStatus: done\n');
  const runner = new SingleTicketRunner(store, new FakeAgentExecutionProvider({ status: 'completed', sessionId: 'session-progress', removable: true, output: ['worker started'] }));
  const plan = { repoRoot, model: { id: 'model-1' }, tickets: [{ path: ticketPath, feature: 'feat', issueName: 'progress', label: 'feat/progress', executorAfk: true }], gitContext: { commits: [] }, checkout: { featureSlug: 'feat', defaultWorktreeName: 'feat', effectiveWorktreeName: 'feat', defaultBranchName: 'afk/feat', effectiveBranchName: 'afk/feat', worktreePath: '/tmp/worktree' } };
  const progress: string[] = [];

  await runner.launch(plan as never, { onProgress: (event) => progress.push(`${event.ticketLabel}: ${event.message}`) });

  assert.deepEqual(progress, [
    'feat/progress: starting ticket run',
    'feat/progress: run completed',
  ]);
});

test('sends ticket file summary instructions to the execution provider', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-prompt-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, '.scratch', 'feat', 'issues', '006.md');
  mkdirSync(path.dirname(ticketPath), { recursive: true });
  writeFileSync(ticketPath, 'Status: ready-for-agent\n\n## Title\n\nImplement the thing\n', { flag: 'w' });
  let capturedPrompt = '';
  const runner = new SingleTicketRunner(store, {
    execute: async ({ prompt }) => {
      capturedPrompt = prompt;
      writeFileSync(ticketPath, 'Status: done\n\n## Title\n\nImplement the thing\n\n## AFK Summary\n\nStatus: completed\n');
      return { status: 'completed', sessionId: 'session-prompt', removable: true };
    },
  });
  const plan = { repoRoot, model: { id: 'model-1' }, reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' }, tickets: [{ path: ticketPath, feature: 'feat', issueName: '006', label: 'feat/006', executorAfk: true }], gitContext: { commits: [] }, checkout: { featureSlug: 'feat', defaultWorktreeName: 'feat', effectiveWorktreeName: 'feat', defaultBranchName: 'afk/feat', effectiveBranchName: 'afk/feat', worktreePath: '/tmp/worktree' } };

  await runner.launch(plan as never);

  assert.match(capturedPrompt, new RegExp(`Ticket file to update: ${ticketPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(capturedPrompt, /Do not put the final AFK summary only in the assistant response, runtime log, or commit message/);
  assert.match(capturedPrompt, /Status: ready-for-agent/);
  assert.match(capturedPrompt, /Reviewer prompt: reviewer-default/);
});

test('uses bundled reviewer prompt when launched from a repo without AFK prompt files', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-bundled-prompt-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, '.scratch', 'feat', 'issues', '007.md');
  mkdirSync(path.dirname(ticketPath), { recursive: true });
  writeFileSync(ticketPath, 'Status: ready-for-agent\n\n## Title\n\nImplement the thing\n');
  const modes: string[] = [];
  const runner = new SingleTicketRunner(store, {
    execute: async ({ invocationMode }) => {
      modes.push(invocationMode ?? 'execution');
      if (invocationMode === 'reviewer') {
        return { status: 'completed', sessionId: 'session-review', removable: true, output: [JSON.stringify({ summary: 'No findings.', findings: [] })] };
      }
      writeFileSync(ticketPath, 'Status: done\n\n## Title\n\nImplement the thing\n\n## AFK Summary\n\nStatus: completed\n');
      return { status: 'completed', sessionId: 'session-execution', removable: true, output: ['worker finished'] };
    },
  });
  const plan = { repoRoot, model: { id: 'model-1' }, reviewerModel: { id: 'review-model' }, reviewerPrompt: resolveReviewerPromptTemplate(), tickets: [{ path: ticketPath, feature: 'feat', issueName: '007', label: 'feat/007', executorAfk: true }], gitContext: { commits: [] }, checkout: { featureSlug: 'feat', defaultWorktreeName: 'feat', effectiveWorktreeName: 'feat', defaultBranchName: 'afk/feat', effectiveBranchName: 'afk/feat', worktreePath: '/tmp/worktree' } };

  const result = await runner.launch(plan as never);

  assert.equal(result.scheduled, true);
  assert.deepEqual(modes, ['execution', 'reviewer']);
  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-007.json');
  assert.match(readFileSync(metadataPath, 'utf8'), /"FINAL_REVIEW_OUTCOME": "approved"/);
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { PHASE_HISTORY?: Array<{ name: string; durationMs: number }> };
  assert.deepEqual(metadata.PHASE_HISTORY?.map((phase) => phase.name), [
    'launch-preparation',
    'worktree-preparation',
    'readiness',
    'execution',
    'review',
    'finalization',
  ]);
  assert.equal((metadata.PHASE_HISTORY ?? []).every((phase) => phase.durationMs >= 0), true);
});

test('does not promote completed runs without an AFK summary', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-summary-missing-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, '---\nfeature: feat\n---\n');
  const runner = new SingleTicketRunner(store, new FakeAgentExecutionProvider({ status: 'completed', sessionId: 'session-2', removable: true }));
  const plan = { repoRoot, model: { id: 'model-1' }, tickets: [{ path: ticketPath, feature: 'feat', issueName: '003', label: 'feat/003', executorAfk: true }], gitContext: { commits: [] }, checkout: { featureSlug: 'feat', defaultWorktreeName: 'feat', effectiveWorktreeName: 'feat', defaultBranchName: 'afk/feat', effectiveBranchName: 'afk/feat', worktreePath: '/tmp/worktree' } };
  await runner.launch(plan as never);
  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-003.json');
  const logPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-003.log');
  assert.match(readFileSync(metadataPath, 'utf8'), /"STATUS": "completed"/);
  assert.match(readFileSync(logPath, 'utf8'), /ready-for-human gate blocked/);
  assert.doesNotMatch(readFileSync(logPath, 'utf8'), /done/);
});

test('promotes completed runs when an AFK summary is present', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-summary-present-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, '---\nfeature: feat\n---\n\n## AFK Summary\nStatus: done\n');
  const runner = new SingleTicketRunner(store, new FakeAgentExecutionProvider({ status: 'completed', sessionId: 'session-3', removable: true }));
  const plan = { repoRoot, model: { id: 'model-1' }, tickets: [{ path: ticketPath, feature: 'feat', issueName: '004', label: 'feat/004', executorAfk: true }], gitContext: { commits: [] }, checkout: { featureSlug: 'feat', defaultWorktreeName: 'feat', effectiveWorktreeName: 'feat', defaultBranchName: 'afk/feat', effectiveBranchName: 'afk/feat', worktreePath: '/tmp/worktree' } };
  await runner.launch(plan as never);
  const logPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-004.log');
  assert.match(readFileSync(logPath, 'utf8'), /run completed/);
});

test('records failed state when the provider throws', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-fail-'));
  const store = new RuntimeStore({ repoRoot });
  const runner = new SingleTicketRunner(store, { execute: async () => { throw new Error('boom'); } });
  const plan = { repoRoot, model: { id: 'model-1' }, tickets: [{ path: '/tmp/ticket.md', feature: 'feat', issueName: '002', label: 'feat/002', executorAfk: true }], gitContext: { commits: [] }, checkout: { featureSlug: 'feat', defaultWorktreeName: 'feat', effectiveWorktreeName: 'feat', defaultBranchName: 'afk/feat', effectiveBranchName: 'afk/feat', worktreePath: '/tmp/worktree' } };
  const result = await runner.launch(plan as never);
  assert.equal(result.scheduled, true);
  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-002.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { STATUS: string; PHASE_HISTORY?: Array<{ name: string; durationMs: number }> };
  assert.equal(metadata.STATUS, 'failed');
  assert.deepEqual(metadata.PHASE_HISTORY?.map((phase) => phase.name), [
    'launch-preparation',
    'worktree-preparation',
    'readiness',
    'execution',
  ]);
  assert.equal((metadata.PHASE_HISTORY ?? []).every((phase) => phase.durationMs >= 0), true);
});

test('persists failed provider output for later inspection', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-failed-output-'));
  const store = new RuntimeStore({ repoRoot });
  const runner = new SingleTicketRunner(store, new FakeAgentExecutionProvider({
    status: 'failed',
    sessionId: 'session-model-error',
    removable: false,
    unsafeReason: 'The requested model is not available for integrator "copilot-language-server".',
    output: ['The requested model is not available for integrator "copilot-language-server".'],
  }));
  const plan = { repoRoot, model: { id: 'model-1' }, tickets: [{ path: '/tmp/ticket.md', feature: 'feat', issueName: '005', label: 'feat/005', executorAfk: true }], gitContext: { commits: [] }, checkout: { featureSlug: 'feat', defaultWorktreeName: 'feat', effectiveWorktreeName: 'feat', defaultBranchName: 'afk/feat', effectiveBranchName: 'afk/feat', worktreePath: '/tmp/worktree' } };

  await runner.launch(plan as never);

  const logPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-005.log');
  assert.match(readFileSync(logPath, 'utf8'), /requested model is not available/);
  assert.match(readFileSync(logPath, 'utf8'), /run failed/);
});

test('persists permission progress before provider completion', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-permission-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, 'Status: done\n\n## AFK Summary\n\nDone\n');
  const runner = new SingleTicketRunner(store, {
    execute: async ({ onProgress }) => {
      onProgress?.({
        ticketLabel: 'feat/permission',
        kind: 'permission',
        message: 'opencode permission required: external_directory for /tmp/worktree/*; requested ask',
        sessionId: 'session-permission',
        permissionId: 'per_1',
      });
      onProgress?.({
        ticketLabel: 'feat/permission',
        message: 'opencode permission once (per_1)',
        sessionId: 'session-permission',
        permissionId: 'per_1',
      });
      return { status: 'completed', sessionId: 'session-permission', removable: true };
    },
  });
  const plan = { repoRoot, model: { id: 'model-1' }, tickets: [{ path: ticketPath, feature: 'feat', issueName: 'permission', label: 'feat/permission', executorAfk: true }], gitContext: { commits: [] }, checkout: { featureSlug: 'feat', defaultWorktreeName: 'feat', effectiveWorktreeName: 'feat', defaultBranchName: 'afk/feat', effectiveBranchName: 'afk/feat', worktreePath: '/tmp/worktree' } };

  await runner.launch(plan as never);

  const logPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-permission.log');
  assert.match(readFileSync(logPath, 'utf8'), /permission required: opencode permission required: external_directory/);
  assert.match(readFileSync(logPath, 'utf8'), /permission event: opencode permission once/);
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

test('scheduler forwards progress events from queued tickets', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-scheduler-progress-'));
  const store = new RuntimeStore({ repoRoot });
  const runner = new SingleTicketRunner(store, new FakeAgentExecutionProvider({ status: 'completed', sessionId: 'session-queued', removable: true }));
  const scheduler = new Scheduler(runner, 1);
  const plan = { repoRoot, model: { id: 'model-1' }, tickets: [
    { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
    { path: '/tmp/b-1.md', feature: 'feat-b', issueName: '001', label: 'feat-b/001', executorAfk: true },
  ], gitContext: { commits: [] }, checkout: { featureSlug: 'feat-a', defaultWorktreeName: 'feat-a', effectiveWorktreeName: 'feat-a', defaultBranchName: 'afk/feat-a', effectiveBranchName: 'afk/feat-a', worktreePath: '/tmp/worktree' } };
  const progress: string[] = [];

  await scheduler.launch(plan as never, { onProgress: (event) => progress.push(`${event.ticketLabel}: ${event.message}`) });

  assert.deepEqual(progress.filter((event) => event.endsWith('starting ticket run')), [
    'feat-a/001: starting ticket run',
    'feat-b/001: starting ticket run',
  ]);
});
