import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentExecutionProvider, AgentExecutionRequest } from '../src/agent-execution-provider.js';
import type { AgentExecutionResult } from '../src/types.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { SingleTicketRunner } from '../src/single-ticket-runner.js';
import { Scheduler } from '../src/scheduler.js';

const REVIEWER_PROMPT_TEXT = '# Reviewer Prompt\n';

function makePlan(
  repoRoot: string,
  ticket: { path: string; feature: string; issueName: string; label: string; executorAfk: boolean },
  overrides: Partial<Record<'reviewerModelId' | 'reviewerPromptId' | 'reviewerPromptPath', string>> = {},
) {
  const reviewerPromptPath = overrides.reviewerPromptPath ?? path.join(repoRoot, 'reviewer-default.md');
  writeFileSync(reviewerPromptPath, REVIEWER_PROMPT_TEXT);

  return {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: overrides.reviewerModelId ?? 'reviewer-model-1' },
    reviewerPrompt: {
      id: overrides.reviewerPromptId ?? 'reviewer-default',
      path: reviewerPromptPath,
    },
    tickets: [ticket],
    gitContext: { commits: [] },
    checkout: { featureSlug: 'feat', defaultWorktreeName: 'feat', effectiveWorktreeName: 'feat', defaultBranchName: 'afk/feat', effectiveBranchName: 'afk/feat', worktreePath: '/tmp/worktree' },
  };
}

function reviewerOutput(findings: Array<{ severity: 'minor' | 'major' | 'blocker'; summary: string; detail?: string }>): string {
  return JSON.stringify({ summary: findings.length ? findings[0].summary : 'Looks good', findings });
}

function makeProvider(steps: Array<(request: AgentExecutionRequest) => AgentExecutionResult>): { provider: AgentExecutionProvider; requests: AgentExecutionRequest[] } {
  const requests: AgentExecutionRequest[] = [];
  let index = 0;
  return {
    requests,
    provider: {
      execute: async (request: AgentExecutionRequest) => {
        requests.push(request);
        const step = steps[index] ?? steps[steps.length - 1];
        index += 1;
        return step(request);
      },
    },
  };
}

test('approves minor-only reviews without another execution cycle', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-approve-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, '---\nfeature: feat\n---\n\n## AFK Summary\nStatus: done\n');

  const { provider, requests } = makeProvider([
    (request) => {
      assert.equal(request.invocationMode, 'execution');
      assert.equal(request.sessionId, null);
      assert.equal(request.prompt, 'AFK run for feat/001');
      return { status: 'completed', sessionId: 'session-1', removable: true, output: ['worker started'] };
    },
    (request) => {
      assert.equal(request.invocationMode, 'reviewer');
      assert.equal(request.sessionId, 'session-1');
      return { status: 'completed', sessionId: 'session-1', removable: false, output: [reviewerOutput([{ severity: 'minor', summary: 'Rename one variable' }])] };
    },
  ]);

  const runner = new SingleTicketRunner(store, provider);
  const plan = makePlan(repoRoot, { path: ticketPath, feature: 'feat', issueName: '001', label: 'feat/001', executorAfk: true });
  const result = await runner.launch(plan as never);

  assert.equal(result.scheduled, true);
  assert.match(result.message, /Scheduled feat\/001/);
  assert.equal(requests.length, 2);

  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-001.json');
  const logPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-001.log');
  const donePath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'sentinels', 'feat-001.done');
  assert.match(readFileSync(metadataPath, 'utf8'), /"STATUS": "completed"/);
  assert.match(readFileSync(metadataPath, 'utf8'), /"REVIEW_CYCLE_HISTORY": \[/);
  assert.match(readFileSync(metadataPath, 'utf8'), /"FINAL_REVIEW_OUTCOME": "approved"/);
  assert.match(readFileSync(logPath, 'utf8'), /"event":"review-cycle"/);
  assert.match(readFileSync(logPath, 'utf8'), /"event":"review-terminal"/);
  assert.match(readFileSync(logPath, 'utf8'), /"outcome":"approved"/);
  assert.match(readFileSync(logPath, 'utf8'), /run completed/);
  assert.match(readFileSync(donePath, 'utf8'), /done/);
});

test('does not promote completed runs without an AFK summary', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-summary-missing-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, '---\nfeature: feat\n---\n');

  const { provider } = makeProvider([
    () => ({ status: 'completed', sessionId: 'session-2', removable: true }),
    () => ({ status: 'completed', sessionId: 'session-2', removable: false, output: [reviewerOutput([{ severity: 'minor', summary: 'Looks fine' }])] }),
  ]);

  const runner = new SingleTicketRunner(store, provider);
  const plan = makePlan(repoRoot, { path: ticketPath, feature: 'feat', issueName: '003', label: 'feat/003', executorAfk: true });
  await runner.launch(plan as never);

  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-003.json');
  const logPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-003.log');
  assert.match(readFileSync(metadataPath, 'utf8'), /"STATUS": "completed"/);
  assert.match(readFileSync(metadataPath, 'utf8'), /"FINAL_REVIEW_OUTCOME": "needs-human"/);
  assert.match(readFileSync(logPath, 'utf8'), /"event":"review-terminal"/);
  assert.match(readFileSync(logPath, 'utf8'), /ready-for-human gate blocked/);
  assert.match(readFileSync(logPath, 'utf8'), /run blocked: missing ## AFK Summary/);
  assert.doesNotMatch(readFileSync(logPath, 'utf8'), /run completed/);
});

test('loops on major findings and continues the same session', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-loop-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, '---\nfeature: feat\n---\n\n## AFK Summary\nStatus: done\n');

  const { provider, requests } = makeProvider([
    (request) => {
      assert.equal(request.invocationMode, 'execution');
      assert.equal(request.sessionId, null);
      return { status: 'completed', sessionId: 'session-3', removable: true, output: ['first pass'] };
    },
    (request) => {
      assert.equal(request.invocationMode, 'reviewer');
      assert.equal(request.sessionId, 'session-3');
      return { status: 'completed', sessionId: 'session-3', removable: false, output: [reviewerOutput([{ severity: 'major', summary: 'Missing guard' }])] };
    },
    (request) => {
      assert.equal(request.invocationMode, 'execution');
      assert.equal(request.sessionId, 'session-3');
      assert.match(request.prompt, /Remediation instructions: create one or more additional conventional fixup commits for the reviewer findings before the next review pass\./);
      assert.match(request.prompt, /Reviewer summary: Missing guard/);
      return { status: 'completed', sessionId: 'session-3', removable: true, output: ['second pass'] };
    },
    (request) => {
      assert.equal(request.invocationMode, 'reviewer');
      assert.equal(request.sessionId, 'session-3');
      return { status: 'completed', sessionId: 'session-3', removable: false, output: [reviewerOutput([{ severity: 'minor', summary: 'Looks good now' }])] };
    },
  ]);

  const runner = new SingleTicketRunner(store, provider);
  const plan = makePlan(repoRoot, { path: ticketPath, feature: 'feat', issueName: '004', label: 'feat/004', executorAfk: true });
  await runner.launch(plan as never);

  const logPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-004.log');
  assert.equal(requests.length, 4);
  assert.match(readFileSync(logPath, 'utf8'), /"cycle":1/);
  assert.match(readFileSync(logPath, 'utf8'), /"cycle":2/);
  assert.match(readFileSync(logPath, 'utf8'), /"outcome":"loop-required"/);
  assert.match(readFileSync(logPath, 'utf8'), /"outcome":"approved"/);
  assert.match(readFileSync(logPath, 'utf8'), /run completed/);
});

test('records failed state when the provider throws', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-fail-'));
  const store = new RuntimeStore({ repoRoot });
  const runner = new SingleTicketRunner(store, { execute: async () => { throw new Error('boom'); } });
  const plan = makePlan(repoRoot, { path: '/tmp/ticket.md', feature: 'feat', issueName: '002', label: 'feat/002', executorAfk: true });
  const result = await runner.launch(plan as never);
  assert.equal(result.scheduled, true);
  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-002.json');
  assert.match(readFileSync(metadataPath, 'utf8'), /"STATUS": "failed"/);
});

test('hands off after three high-severity review cycles', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-handoff-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, '---\nfeature: feat\n---\n\n## AFK Summary\nStatus: done\n');

  const { provider } = makeProvider([
    () => ({ status: 'completed', sessionId: 'session-4', removable: true }),
    () => ({ status: 'completed', sessionId: 'session-4', removable: false, output: [reviewerOutput([{ severity: 'major', summary: 'Missing guard' }])] }),
    () => ({ status: 'completed', sessionId: 'session-4', removable: true }),
    () => ({ status: 'completed', sessionId: 'session-4', removable: false, output: [reviewerOutput([{ severity: 'blocker', summary: 'Data loss risk' }])] }),
    () => ({ status: 'completed', sessionId: 'session-4', removable: true }),
    () => ({ status: 'completed', sessionId: 'session-4', removable: false, output: [reviewerOutput([{ severity: 'major', summary: 'Still broken' }])] }),
  ]);

  const runner = new SingleTicketRunner(store, provider);
  const plan = makePlan(repoRoot, { path: ticketPath, feature: 'feat', issueName: '005', label: 'feat/005', executorAfk: true });
  await runner.launch(plan as never);

  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-005.json');
  const logPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-005.log');
  assert.match(readFileSync(metadataPath, 'utf8'), /"STATUS": "blocked"/);
  assert.match(readFileSync(metadataPath, 'utf8'), /"UNSAFE_REASON": "Reviewer cycle cap reached with unresolved major findings"/);
  assert.match(readFileSync(metadataPath, 'utf8'), /"FINAL_REVIEW_OUTCOME": "needs-human"/);
  assert.match(readFileSync(logPath, 'utf8'), /"event":"review-terminal"/);
  assert.match(readFileSync(logPath, 'utf8'), /needs-human handoff: Reviewer cycle cap reached with unresolved major findings/);
  assert.match(readFileSync(logPath, 'utf8'), /run blocked/);
});

test('scheduler queues tickets by feature and starts the next queued ticket after completion', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-scheduler-'));
  const store = new RuntimeStore({ repoRoot });
  const started: string[] = [];
  writeFileSync(path.join(repoRoot, 'reviewer-default.md'), REVIEWER_PROMPT_TEXT);
  const runner = new SingleTicketRunner(store, { execute: async ({ plan, invocationMode }) => {
    const ticket = plan.tickets[0];
    assert.equal(plan.reviewerModel.id, 'reviewer-model-1');
    assert.equal(plan.reviewerPrompt.id, 'reviewer-default');
    if (!ticket) throw new Error('missing ticket');
    if (plan.tickets.length !== 1) throw new Error('unexpected ticket batch size');
    if (invocationMode === 'reviewer') {
      return { status: 'completed', sessionId: ticket.label, removable: false, output: [reviewerOutput([{ severity: 'minor', summary: 'Looks good' }])] };
    }
    started.push(ticket.label);
    return { status: 'completed', sessionId: ticket.label, removable: true };
  } });
  const scheduler = new Scheduler(runner);
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'reviewer-model-1' },
    reviewerPrompt: { id: 'reviewer-default', path: path.join(repoRoot, 'reviewer-default.md') },
    tickets: [
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
      { path: '/tmp/b-1.md', feature: 'feat-b', issueName: '001', label: 'feat-b/001', executorAfk: true },
      { path: '/tmp/a-2.md', feature: 'feat-a', issueName: '002', label: 'feat-a/002', executorAfk: true },
    ],
    gitContext: { commits: [] },
    checkout: { featureSlug: 'feat-a', defaultWorktreeName: 'feat-a', effectiveWorktreeName: 'feat-a', defaultBranchName: 'afk/feat-a', effectiveBranchName: 'afk/feat-a', worktreePath: '/tmp/worktree' },
  };

  await scheduler.launch(plan as never);
  assert.deepEqual(started, ['feat-a/001', 'feat-b/001', 'feat-a/002']);
});
