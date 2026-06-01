import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FakeAgentExecutionProvider } from '../src/agent-execution-provider.js';
import { resolveExecutable } from '../src/executable-resolution.js';
import { resolveReviewerPromptTemplate } from '../src/reviewer-prompt-catalog.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { Scheduler } from '../src/scheduler.js';
import { SingleTicketRunner } from '../src/single-ticket-runner.js';

const GIT_PATH = resolveExecutable('git');

function git(repoRoot: string, args: string[]): string {
  return execFileSync(GIT_PATH, args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

test('launches one ticket and writes runtime artifacts before exit', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-'));
  const store = new RuntimeStore({ repoRoot });
  const runner = new SingleTicketRunner(
    store,
    new FakeAgentExecutionProvider({
      status: 'completed',
      sessionId: 'session-1',
      removable: true,
      output: ['worker started'],
    }),
  );
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [{ path: '/tmp/ticket.md', feature: 'feat', issueName: '001', label: 'feat/001', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };
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
  const runner = new SingleTicketRunner(store, {
    execute: async ({ invocationMode }) => {
      if (invocationMode === 'reviewer') {
        return {
          status: 'completed',
          sessionId: 'session-review',
          removable: true,
          output: [JSON.stringify({ done: true, summary: 'Clean pass', findings: [] })],
        };
      }
      return {
        status: 'completed',
        sessionId: 'session-progress',
        removable: true,
        output: ['worker started'],
      };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    tickets: [{ path: ticketPath, feature: 'feat', issueName: 'progress', label: 'feat/progress', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' },
  };
  const progress: string[] = [];

  await runner.launch(plan as never, {
    onProgress: (event) => progress.push(`${event.ticketLabel}: ${event.message}`),
  });

  assert.deepEqual(progress, ['feat/progress: starting ticket run', 'feat/progress: run completed']);
});

test('installs commit hook that strips AI attribution trailers', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-commit-hook-'));
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  writeFileSync(path.join(repoRoot, 'README.md'), 'base\n');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-m', 'init']);

  const ticketPath = path.join(repoRoot, '.scratch', 'feat', 'issues', '001.md');
  mkdirSync(path.dirname(ticketPath), { recursive: true });
  writeFileSync(ticketPath, '---\nstatus: ready-for-agent\n---\n\n## Ticket\n');

  const store = new RuntimeStore({ repoRoot });
  const runner = new SingleTicketRunner(store, {
    execute: async ({ invocationMode }) => {
      if (invocationMode === 'reviewer') {
        return {
          status: 'completed',
          sessionId: 'review-session',
          removable: true,
          output: [JSON.stringify({ done: true, summary: 'Clean pass', findings: [] })],
        };
      }
      writeFileSync(path.join(repoRoot, 'marker.txt'), 'marker\n');
      writeFileSync(ticketPath, '---\nstatus: done\n---\n\n## Ticket\n\n## AFK Summary\n\n### Reviewer Notes\nDone.\n');
      git(repoRoot, ['add', 'marker.txt']);
      git(repoRoot, ['add', '-f', ticketPath]);
      git(repoRoot, [
        'commit',
        '-m',
        'feat: add marker',
        '-m',
        'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>',
      ]);
      return { status: 'completed', sessionId: 'execution-session', removable: true };
    },
  });

  const result = await runner.launch({
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [{ path: ticketPath, feature: 'feat', issueName: '001', label: 'feat/001', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: repoRoot,
    },
  });

  assert.equal(result.outcome, 'completed');
  assert.doesNotMatch(git(repoRoot, ['log', '-1', '--format=%B']), /Co-Authored-By/i);
});

test('persists provider session id as soon as progress observes it', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-session-observed-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, 'Status: done\n\n## AFK Summary\nDone\n');
  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-observed.json');
  let observedDuringExecution = '';
  const runner = new SingleTicketRunner(store, {
    execute: async ({ onProgress, invocationMode }) => {
      if (invocationMode === 'reviewer') {
        return {
          status: 'completed',
          sessionId: 'session-review',
          removable: true,
          output: [JSON.stringify({ done: true, summary: 'Clean pass', findings: [] })],
        };
      }
      onProgress?.({
        ticketLabel: 'feat/observed',
        message: 'created opencode session session-observed',
        sessionId: 'session-observed',
      });
      observedDuringExecution = readFileSync(metadataPath, 'utf8');
      return { status: 'completed', sessionId: 'session-observed', removable: true, output: ['done'] };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    tickets: [{ path: ticketPath, feature: 'feat', issueName: 'observed', label: 'feat/observed', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' },
  };

  await runner.launch(plan as never);

  assert.match(observedDuringExecution, /"PROVIDER_SESSION_ID": "session-observed"/);
  assert.match(observedDuringExecution, /"UNSAFE_REASON": "session still running"/);
});

test('sends ticket file summary instructions to the execution provider', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-prompt-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, '.scratch', 'feat', 'issues', '006.md');
  mkdirSync(path.dirname(ticketPath), { recursive: true });
  writeFileSync(ticketPath, 'Status: ready-for-agent\n\n## Title\n\nImplement the thing\n', { flag: 'w' });
  let capturedPrompt = '';
  const runner = new SingleTicketRunner(store, {
    execute: async ({ prompt, invocationMode }) => {
      if (invocationMode === 'reviewer') {
        return {
          status: 'completed',
          sessionId: 'session-review',
          removable: true,
          output: [JSON.stringify({ done: true, summary: 'Clean pass', findings: [] })],
        };
      }
      capturedPrompt = prompt;
      writeFileSync(
        ticketPath,
        'Status: done\n\n## Title\n\nImplement the thing\n\n## AFK Summary\n\nStatus: completed\n',
      );
      return { status: 'completed', sessionId: 'session-prompt', removable: true };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' },
    tickets: [{ path: ticketPath, feature: 'feat', issueName: '006', label: 'feat/006', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
    reviewerModel: { id: 'review-model' },
  };

  await runner.launch(plan as never);

  assert.match(
    capturedPrompt,
    new RegExp(`Ticket file to update: ${ticketPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  assert.match(
    capturedPrompt,
    /Do not put the final AFK summary only in the assistant response, runtime log, or commit message/,
  );
  assert.match(capturedPrompt, /Status: ready-for-agent/);
  assert.match(capturedPrompt, /Reviewer prompt: reviewer-default/);
  assert.match(capturedPrompt, /### Reviewer Notes/);
  assert.match(capturedPrompt, /changes made/);
  assert.match(capturedPrompt, /tests run/);
  assert.match(capturedPrompt, /caveats or risks/);
});

test('injects reviewer-notes requirement even when custom AFK instructions are loaded', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-custom-afk-'));
  const afkPromptPath = path.join(repoRoot, 'src', 'prompts', 'afk-prompt.md');
  mkdirSync(path.dirname(afkPromptPath), { recursive: true });
  writeFileSync(afkPromptPath, '# Custom AFK Instructions\n\nCustom rules here.\n');
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, '.scratch', 'feat', 'issues', '008.md');
  mkdirSync(path.dirname(ticketPath), { recursive: true });
  writeFileSync(ticketPath, 'Status: ready-for-agent\n\n## Title\n\nImplement the thing\n');
  let capturedPrompt = '';
  const runner = new SingleTicketRunner(store, {
    execute: async ({ prompt, invocationMode }) => {
      if (invocationMode === 'reviewer') {
        return {
          status: 'completed',
          sessionId: 'session-review',
          removable: true,
          output: [JSON.stringify({ done: true, summary: 'Clean pass', findings: [] })],
        };
      }
      capturedPrompt = prompt;
      writeFileSync(
        ticketPath,
        'Status: done\n\n## Title\n\nImplement the thing\n\n## AFK Summary\n\nStatus: completed\n',
      );
      return { status: 'completed', sessionId: 'session-prompt', removable: true };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' },
    tickets: [{ path: ticketPath, feature: 'feat', issueName: '008', label: 'feat/008', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
    reviewerModel: { id: 'review-model' },
  };

  await runner.launch(plan as never);

  assert.match(capturedPrompt, /Custom rules here/);
  assert.match(capturedPrompt, /### Reviewer Notes/);
  assert.match(capturedPrompt, /changes made/);
  assert.match(capturedPrompt, /tests run/);
  assert.match(capturedPrompt, /caveats or risks/);
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
        return {
          status: 'completed',
          sessionId: 'session-review',
          removable: true,
          output: [JSON.stringify({ done: true, summary: 'No findings.', findings: [] })],
        };
      }
      writeFileSync(
        ticketPath,
        'Status: done\n\n## Title\n\nImplement the thing\n\n## AFK Summary\n\nStatus: completed\n',
      );
      return { status: 'completed', sessionId: 'session-execution', removable: true, output: ['worker finished'] };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [{ path: ticketPath, feature: 'feat', issueName: '007', label: 'feat/007', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };

  const result = await runner.launch(plan as never);

  assert.equal(result.scheduled, true);
  assert.deepEqual(modes, ['execution', 'reviewer']);
  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-007.json');
  assert.match(readFileSync(metadataPath, 'utf8'), /"FINAL_REVIEW_OUTCOME": "approved"/);
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
    PHASE_HISTORY?: Array<{ name: string; durationMs: number }>;
  };
  assert.deepEqual(
    metadata.PHASE_HISTORY?.map((phase) => phase.name),
    ['launch-preparation', 'worktree-preparation', 'readiness', 'execution', 'review', 'finalization'],
  );
  assert.equal(
    (metadata.PHASE_HISTORY ?? []).every((phase) => phase.durationMs >= 0),
    true,
  );
  assert.match(readFileSync(metadataPath, 'utf8'), /"FINAL_REVIEW_CLASSIFICATION": "clean-approval"/);
});

test('blocks before provider execution when launch context mismatches', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-context-mismatch-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, '.scratch', 'feat', 'issues', '001.md');
  mkdirSync(path.dirname(ticketPath), { recursive: true });
  writeFileSync(ticketPath, 'Status: ready-for-agent\n');
  let called = false;
  const runner = new SingleTicketRunner(store, {
    execute: async () => {
      called = true;
      return { status: 'completed' };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [{ path: ticketPath, feature: 'feat', issueName: '001', label: 'feat/001', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree-a',
    },
    snapshots: {
      'feat/001': {
        generatedAt: 'now',
        ticketLabel: 'feat/001',
        ticketStatus: 'ready',
        ticketIssueName: '001',
        featureSlug: 'feat',
        ticketPath,
        repoRoot,
        worktreePath: '/tmp/worktree-b',
        worktreeName: 'other',
        branchName: 'feat',
        head: 'head',
        gitStatusShort: [],
        ticketOutsideWorktree: true,
        dependencies: [],
        readiness: null,
      },
    },
  };

  await runner.launch(plan as never);

  assert.equal(called, false);
  const metadata = readFileSync(
    path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-001.json'),
    'utf8',
  );
  assert.match(metadata, /"STATUS": "blocked"/);
  assert.match(metadata, /"FAILURE_KIND": "launcher-context-mismatch"/);
});

test('hands off when reviewer output stays empty after retry', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-empty-review-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, '.scratch', 'feat', 'issues', 'empty-review.md');
  mkdirSync(path.dirname(ticketPath), { recursive: true });
  writeFileSync(ticketPath, 'Status: done\n\n## AFK Summary\nDone\n');
  let reviewerCalls = 0;
  const runner = new SingleTicketRunner(store, {
    execute: async ({ invocationMode }) => {
      if (invocationMode === 'reviewer') {
        reviewerCalls += 1;
        return { status: 'completed', sessionId: 'review-empty', output: [] };
      }
      return { status: 'completed', sessionId: 'exec', output: ['done'] };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [
      { path: ticketPath, feature: 'feat', issueName: 'empty-review', label: 'feat/empty-review', executorAfk: true },
    ],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };

  await runner.launch(plan as never);

  const metadata = readFileSync(
    path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-empty-review.json'),
    'utf8',
  );
  assert.equal(reviewerCalls, 3);
  assert.match(metadata, /"STATUS": "blocked"/);
  assert.match(metadata, /"FINAL_REVIEW_OUTCOME": "needs-human"/);
  assert.match(metadata, /"FAILURE_KIND": "reviewer-empty-output"/);
});

test('records clean approval metadata when reviewer confirms done with no findings', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-clean-approval-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, 'Status: done\n\n## AFK Summary\n\nDone\n');
  const runner = new SingleTicketRunner(store, {
    execute: async ({ invocationMode }) => {
      if (invocationMode === 'reviewer') {
        return {
          status: 'completed',
          sessionId: 'session-review',
          removable: true,
          output: [
            JSON.stringify({
              done: true,
              summary: 'Clean pass',
              findings: [],
            }),
          ],
        };
      }
      return {
        status: 'completed',
        sessionId: 'session-exec',
        removable: true,
        output: ['implementation pass complete'],
      };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [
      {
        path: ticketPath,
        feature: 'feat',
        issueName: 'clean-approval',
        label: 'feat/clean-approval',
        executorAfk: true,
      },
    ],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };

  await runner.launch(plan as never);

  const metadataPath = path.join(
    repoRoot,
    '.scratch',
    '.opencode-afk-logs',
    'runtime-metadata',
    'feat-clean-approval.json',
  );
  const metadata = readFileSync(metadataPath, 'utf8');
  assert.match(metadata, /"FINAL_REVIEW_OUTCOME": "approved"/);
  assert.match(metadata, /"FINAL_REVIEW_CLASSIFICATION": "clean-approval"/);
  assert.match(metadata, /"FINAL_REVIEW_FINDINGS": \[\]/);
});

test('hands off without fixup when reviewer returns no findings and done:false', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-empty-findings-handoff-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, 'Status: done\n\n## AFK Summary\n\nDone\n');
  let executionCalls = 0;
  let reviewerCalls = 0;
  const runner = new SingleTicketRunner(store, {
    execute: async ({ invocationMode }) => {
      if (invocationMode === 'reviewer') {
        reviewerCalls += 1;
        return {
          status: 'completed',
          sessionId: 'session-review',
          removable: true,
          output: [
            JSON.stringify({
              done: false,
              summary: 'No specific issues found but ticket seems incomplete',
              findings: [],
            }),
          ],
        };
      }
      executionCalls += 1;
      return {
        status: 'completed',
        sessionId: 'session-exec',
        removable: true,
        output: ['implementation pass complete'],
      };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [
      {
        path: ticketPath,
        feature: 'feat',
        issueName: 'empty-findings',
        label: 'feat/empty-findings',
        executorAfk: true,
      },
    ],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };

  await runner.launch(plan as never);

  assert.equal(executionCalls, 1);
  assert.equal(reviewerCalls, 1);
  const metadataPath = path.join(
    repoRoot,
    '.scratch',
    '.opencode-afk-logs',
    'runtime-metadata',
    'feat-empty-findings.json',
  );
  const metadata = readFileSync(metadataPath, 'utf8');
  assert.match(metadata, /"STATUS": "blocked"/);
  assert.match(metadata, /"FINAL_REVIEW_OUTCOME": "needs-human"/);
  assert.match(metadata, /"FINAL_REVIEW_CLASSIFICATION": "missing-findings-handoff"/);
  assert.match(metadata, /"classification": "missing-findings-handoff"/);
  assert.match(metadata, /"FINAL_REVIEW_FINDINGS": \[\]/);
  assert.match(metadata, /Reviewer output had no actionable findings/);
});

test('records real-finding loop and handoff metadata for unresolved major findings', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-real-finding-handoff-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, 'Status: ready-for-agent\n\n## Title\n\nImplement the thing\n');
  const runner = new SingleTicketRunner(store, {
    execute: async ({ invocationMode }) => {
      if (invocationMode === 'reviewer') {
        return {
          status: 'completed',
          sessionId: 'session-review',
          removable: true,
          output: [
            JSON.stringify({
              done: false,
              summary: 'Needs more work',
              findings: [{ severity: 'major', title: 'Fix behavior', detail: 'Condition is wrong' }],
            }),
          ],
        };
      }
      return {
        status: 'completed',
        sessionId: 'session-exec',
        removable: true,
        output: ['implementation pass complete'],
      };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [
      { path: ticketPath, feature: 'feat', issueName: 'real-finding', label: 'feat/real-finding', executorAfk: true },
    ],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };

  await runner.launch(plan as never);

  const metadataPath = path.join(
    repoRoot,
    '.scratch',
    '.opencode-afk-logs',
    'runtime-metadata',
    'feat-real-finding.json',
  );
  const metadata = readFileSync(metadataPath, 'utf8');
  assert.match(metadata, /"classification": "real-finding-loop"/);
  assert.match(metadata, /"FINAL_REVIEW_CLASSIFICATION": "real-finding-handoff"/);
  assert.match(metadata, /"FINAL_REVIEW_OUTCOME": "needs-human"/);
});

test('records failed state when the provider throws', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-fail-'));
  const store = new RuntimeStore({ repoRoot });
  const runner = new SingleTicketRunner(
    store,
    {
      execute: async () => {
        throw new Error('boom');
      },
    },
    { providerFailureRetries: 0 },
  );
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    tickets: [{ path: '/tmp/ticket.md', feature: 'feat', issueName: '002', label: 'feat/002', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' },
  };
  const result = await runner.launch(plan as never);
  assert.equal(result.scheduled, true);
  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-002.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
    STATUS: string;
    PHASE_HISTORY?: Array<{ name: string; durationMs: number }>;
  };
  assert.equal(metadata.STATUS, 'failed');
  assert.deepEqual(
    metadata.PHASE_HISTORY?.map((phase) => phase.name),
    ['launch-preparation', 'worktree-preparation', 'readiness', 'execution', 'finalization'],
  );
  assert.equal(
    (metadata.PHASE_HISTORY ?? []).every((phase) => phase.durationMs >= 0),
    true,
  );
});

test('persists failed provider output for later inspection', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-failed-output-'));
  const store = new RuntimeStore({ repoRoot });
  const runner = new SingleTicketRunner(
    store,
    new FakeAgentExecutionProvider({
      status: 'failed',
      sessionId: 'session-model-error',
      removable: false,
      unsafeReason: 'The requested model is not available for integrator "copilot-language-server".',
      output: ['The requested model is not available for integrator "copilot-language-server".'],
    }),
  );
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    tickets: [{ path: '/tmp/ticket.md', feature: 'feat', issueName: '005', label: 'feat/005', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' },
  };

  await runner.launch(plan as never);

  const logPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-005.log');
  assert.match(readFileSync(logPath, 'utf8'), /requested model is not available/);
  assert.match(readFileSync(logPath, 'utf8'), /run failed/);
});

test('records path-not-found failure kind for failed provider results', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-failure-kind-path-'));
  const store = new RuntimeStore({ repoRoot });
  const runner = new SingleTicketRunner(
    store,
    new FakeAgentExecutionProvider({
      status: 'failed',
      sessionId: 'session-missing-path',
      removable: false,
      unsafeReason: 'ENOENT: no such file or directory, open "/tmp/missing.md"',
      output: ['Tool failed: ENOENT: no such file or directory'],
    }),
  );
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    tickets: [
      {
        path: '/tmp/ticket.md',
        feature: 'feat',
        issueName: 'path-missing',
        label: 'feat/path-missing',
        executorAfk: true,
      },
    ],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' },
  };

  await runner.launch(plan as never);

  const metadataPath = path.join(
    repoRoot,
    '.scratch',
    '.opencode-afk-logs',
    'runtime-metadata',
    'feat-path-missing.json',
  );
  assert.match(readFileSync(metadataPath, 'utf8'), /"FAILURE_KIND": "path-not-found"/);
});

test('records patch-context-mismatch failure kind when provider throws', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-failure-kind-patch-'));
  const store = new RuntimeStore({ repoRoot });
  const runner = new SingleTicketRunner(store, {
    execute: async () => {
      throw new Error('apply_patch verification failed: Failed to find expected lines in src/file.ts');
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    tickets: [
      {
        path: '/tmp/ticket.md',
        feature: 'feat',
        issueName: 'patch-mismatch',
        label: 'feat/patch-mismatch',
        executorAfk: true,
      },
    ],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' },
  };

  await runner.launch(plan as never);

  const metadataPath = path.join(
    repoRoot,
    '.scratch',
    '.opencode-afk-logs',
    'runtime-metadata',
    'feat-patch-mismatch.json',
  );
  assert.match(readFileSync(metadataPath, 'utf8'), /"FAILURE_KIND": "patch-context-mismatch"/);
});

test('records dependency-missing failure kind when provider throws', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-failure-kind-deps-'));
  const store = new RuntimeStore({ repoRoot });
  const runner = new SingleTicketRunner(store, {
    execute: async () => {
      throw new Error('require(vendor/autoload.php): Failed to open stream: No such file or directory');
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    tickets: [
      {
        path: '/tmp/ticket.md',
        feature: 'feat',
        issueName: 'dependency-missing',
        label: 'feat/dependency-missing',
        executorAfk: true,
      },
    ],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' },
  };

  await runner.launch(plan as never);

  const metadataPath = path.join(
    repoRoot,
    '.scratch',
    '.opencode-afk-logs',
    'runtime-metadata',
    'feat-dependency-missing.json',
  );
  assert.match(readFileSync(metadataPath, 'utf8'), /"FAILURE_KIND": "dependency-missing"/);
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
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    tickets: [
      { path: ticketPath, feature: 'feat', issueName: 'permission', label: 'feat/permission', executorAfk: true },
    ],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' },
  };

  await runner.launch(plan as never);

  const logPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-permission.log');
  assert.match(readFileSync(logPath, 'utf8'), /permission required: opencode permission required: external_directory/);
  assert.match(readFileSync(logPath, 'utf8'), /permission event: opencode permission once/);
});

test('scheduler queues tickets by feature and starts the next queued ticket after completion', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-scheduler-'));
  const store = new RuntimeStore({ repoRoot });
  const started: string[] = [];
  const runner = new SingleTicketRunner(store, {
    execute: async ({ plan, invocationMode }) => {
      const ticket = plan.tickets[0];
      if (invocationMode === 'reviewer') {
        return {
          status: 'completed',
          sessionId: `${ticket.label}-review`,
          removable: true,
          output: [JSON.stringify({ done: true, summary: 'Clean pass', findings: [] })],
        };
      }
      started.push(ticket.label);
      return { status: 'completed', sessionId: ticket.label, removable: true };
    },
  });
  const scheduler = new Scheduler({
    runner,
    scratchWorktreeService: {
      createScratchWorktree: (input: {
        repoRoot: string;
        featureSlug: string;
        issueName: string;
        baseRef?: string;
      }) => ({
        featureSlug: input.featureSlug,
        defaultWorktreeName: `${input.featureSlug}-${input.issueName}`,
        effectiveWorktreeName: `${input.featureSlug}-${input.issueName}`,
        defaultBranchName: `afk/${input.featureSlug}/${input.issueName}`,
        effectiveBranchName: `afk/${input.featureSlug}/${input.issueName}`,
        worktreePath: `/scratch/${input.featureSlug}-${input.issueName}`,
      }),
      removeScratchWorktree: () => {},
    } as never,
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    tickets: [
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
      { path: '/tmp/b-1.md', feature: 'feat-b', issueName: '001', label: 'feat-b/001', executorAfk: true },
      { path: '/tmp/a-2.md', feature: 'feat-a', issueName: '002', label: 'feat-a/002', executorAfk: true },
    ],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat-a',
      defaultWorktreeName: 'feat-a',
      effectiveWorktreeName: 'feat-a',
      defaultBranchName: 'feat-a',
      effectiveBranchName: 'feat-a',
      worktreePath: '/tmp/worktree',
    },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' },
  };

  await scheduler.launch(plan as never);
  // feat-a/001 and feat-a/002 are now concurrent (no dependency), so order is non-deterministic
  assert.equal(started.includes('feat-a/001'), true);
  assert.equal(started.includes('feat-b/001'), true);
  assert.equal(started.includes('feat-a/002'), true);
});

test('scheduler forwards progress events from queued tickets', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-scheduler-progress-'));
  const store = new RuntimeStore({ repoRoot });
  const runner = new SingleTicketRunner(
    store,
    new FakeAgentExecutionProvider({ status: 'completed', sessionId: 'session-queued', removable: true }),
  );
  const scheduler = new Scheduler({
    runner,
    scratchWorktreeService: {
      createScratchWorktree: (input: {
        repoRoot: string;
        featureSlug: string;
        issueName: string;
        baseRef?: string;
      }) => ({
        featureSlug: input.featureSlug,
        defaultWorktreeName: `${input.featureSlug}-${input.issueName}`,
        effectiveWorktreeName: `${input.featureSlug}-${input.issueName}`,
        defaultBranchName: `afk/${input.featureSlug}/${input.issueName}`,
        effectiveBranchName: `afk/${input.featureSlug}/${input.issueName}`,
        worktreePath: `/scratch/${input.featureSlug}-${input.issueName}`,
      }),
      removeScratchWorktree: () => {},
    } as never,
    concurrencyLimit: 1,
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    tickets: [
      { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
      { path: '/tmp/b-1.md', feature: 'feat-b', issueName: '001', label: 'feat-b/001', executorAfk: true },
    ],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat-a',
      defaultWorktreeName: 'feat-a',
      effectiveWorktreeName: 'feat-a',
      defaultBranchName: 'feat-a',
      effectiveBranchName: 'feat-a',
      worktreePath: '/tmp/worktree',
    },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' },
  };
  const progress: string[] = [];

  await scheduler.launch(plan as never, {
    onProgress: (event) => progress.push(`${event.ticketLabel}: ${event.message}`),
  });

  assert.deepEqual(
    progress.filter((event) => event.endsWith('starting ticket run')),
    ['feat-a/001: starting ticket run', 'feat-b/001: starting ticket run'],
  );
});

test('retries malformed reviewer once without starting another execution', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-budget-malformed-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, 'Status: done\n\n## AFK Summary\n\nDone\n');
  let executionCalls = 0;
  let reviewCalls = 0;
  const runner = new SingleTicketRunner(store, {
    execute: async ({ invocationMode }) => {
      if (invocationMode === 'reviewer') {
        reviewCalls += 1;
        if (reviewCalls === 1) return { status: 'completed', sessionId: 's-review', output: ['not json'] };
        return {
          status: 'completed',
          sessionId: 's-review',
          output: [JSON.stringify({ done: true, summary: 'ok', findings: [] })],
        };
      }
      executionCalls += 1;
      return { status: 'completed', sessionId: 's-exec' };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [{ path: ticketPath, feature: 'feat', issueName: 'm1', label: 'feat/m1', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };

  await runner.launch(plan as never);

  assert.equal(executionCalls, 1);
  assert.equal(reviewCalls, 2);
});

test('hands off when malformed reviewer retry budget is exceeded', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-budget-malformed-cap-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, 'Status: ready-for-agent\n');
  const runner = new SingleTicketRunner(store, {
    execute: async ({ invocationMode }) =>
      invocationMode === 'reviewer'
        ? { status: 'completed', sessionId: 's-review', output: ['not json'] }
        : { status: 'completed', sessionId: 's-exec' },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [{ path: ticketPath, feature: 'feat', issueName: 'm2', label: 'feat/m2', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };

  await runner.launch(plan as never);
  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-m2.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
    STATUS: string;
    FAILURE_KIND?: string;
    FINAL_REVIEW_CLASSIFICATION?: string;
  };
  assert.equal(metadata.STATUS, 'blocked');
  assert.equal(metadata.FAILURE_KIND, 'reviewer-output-malformed');
  assert.equal(metadata.FINAL_REVIEW_CLASSIFICATION, 'malformed-output-handoff');
});

test('treats failed reviewer sessions as provider failures instead of malformed output', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-reviewer-provider-failure-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, 'Status: done\n\n## AFK Summary\n\nDone\n');
  let executionCalls = 0;
  let reviewCalls = 0;
  const runner = new SingleTicketRunner(
    store,
    {
      execute: async ({ invocationMode }) => {
        if (invocationMode === 'reviewer') {
          reviewCalls += 1;
          return {
            status: 'failed',
            sessionId: `s-review-${reviewCalls}`,
            unsafeReason: 'opencode session stale after 3 recovery attempts',
            output: [resolveReviewerPromptTemplate().content ?? ''],
          };
        }

        executionCalls += 1;
        return { status: 'completed', sessionId: 's-exec' };
      },
    },
    { providerFailureRetries: 1 },
  );
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [
      { path: ticketPath, feature: 'feat', issueName: 'review-fail', label: 'feat/review-fail', executorAfk: true },
    ],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };

  await runner.launch(plan as never);

  assert.equal(executionCalls, 1);
  assert.equal(reviewCalls, 2);
  const metadataPath = path.join(
    repoRoot,
    '.scratch',
    '.opencode-afk-logs',
    'runtime-metadata',
    'feat-review-fail.json',
  );
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
    STATUS: string;
    IMPLEMENTATION_STATUS?: string;
    REVIEW_STATUS?: string;
    RUN_STATUS?: string;
    FAILURE_KIND?: string;
    FINAL_REVIEW_CLASSIFICATION?: string;
  };
  assert.equal(metadata.STATUS, 'blocked');
  assert.equal(metadata.IMPLEMENTATION_STATUS, 'completed');
  assert.equal(metadata.REVIEW_STATUS, 'failed');
  assert.equal(metadata.RUN_STATUS, 'handoff');
  assert.equal(metadata.FAILURE_KIND, 'opencode-session-stale');
  assert.notEqual(metadata.FINAL_REVIEW_CLASSIFICATION, 'malformed-output-handoff');
});

test('applies real fixup cap to major findings and then hands off', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-budget-fixup-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, 'Status: ready-for-agent\n');
  let executionCalls = 0;
  const runner = new SingleTicketRunner(store, {
    execute: async ({ invocationMode }) => {
      if (invocationMode === 'reviewer') {
        return {
          status: 'completed',
          sessionId: 's-review',
          output: [
            JSON.stringify({
              done: false,
              summary: 'still broken',
              findings: [{ severity: 'major', title: 'x', detail: 'y' }],
            }),
          ],
        };
      }
      executionCalls += 1;
      return { status: 'completed', sessionId: 's-exec' };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [{ path: ticketPath, feature: 'feat', issueName: 'fx', label: 'feat/fx', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };

  await runner.launch(plan as never);
  assert.equal(executionCalls, 50);
  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-fx.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
    BUDGET_EXCEEDED_EVENTS?: Array<{ budgetName: string }>;
  };
  assert.equal(metadata.BUDGET_EXCEEDED_EVENTS?.[0]?.budgetName, 'fixup-cycle-cap');
});

test('starts a fresh implementation session for review fixups', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-fresh-fixup-session-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, 'Status: ready-for-agent\n\n## Title\n\nImplement the thing\n');
  const executionSessionIds: Array<string | null | undefined> = [];
  let fixupPrompt = '';
  let reviewerCalls = 0;
  let executionCalls = 0;
  const runner = new SingleTicketRunner(store, {
    execute: async ({ invocationMode, prompt, sessionId }) => {
      if (invocationMode === 'reviewer') {
        reviewerCalls += 1;
        return {
          status: 'completed',
          sessionId: 'session-review',
          removable: true,
          output: [
            JSON.stringify(
              reviewerCalls === 1
                ? {
                    done: false,
                    summary: 'Needs fix',
                    findings: [{ severity: 'major', title: 'Bug', detail: 'Patch it' }],
                  }
                : { done: true, summary: 'Looks good', findings: [] },
            ),
          ],
        };
      }

      executionCalls += 1;
      executionSessionIds.push(sessionId);
      if (executionCalls === 2) {
        fixupPrompt = prompt;
        writeFileSync(ticketPath, 'Status: done\n\n## Title\n\nImplement the thing\n\n## AFK Summary\n\nDone\n');
      }
      return {
        status: 'completed',
        sessionId: `session-exec-${executionCalls}`,
        removable: true,
        output: ['implementation pass complete'],
      };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [
      {
        path: ticketPath,
        feature: 'feat',
        issueName: 'fresh-fixup-session',
        label: 'feat/fresh-fixup-session',
        executorAfk: true,
      },
    ],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };

  await runner.launch(plan as never);

  assert.deepEqual(executionSessionIds, [null, null]);
  assert.match(fixupPrompt, /Start a fresh implementation session for this fixup\./);
  assert.match(fixupPrompt, /Prior implementation session for reference only: session-exec-1/);
  assert.match(fixupPrompt, /Inspect the current repository state before editing/);
  assert.match(fixupPrompt, /Make only incremental changes needed for these reviewer findings/);
  const logPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-fresh-fixup-session.log');
  assert.match(
    readFileSync(logPath, 'utf8'),
    /starting fresh implementation session for fixup; prior session: session-exec-1/,
  );
});

test('does not retry implementation when provider fails by default', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-budget-provider-'));
  const store = new RuntimeStore({ repoRoot });
  let calls = 0;
  const runner = new SingleTicketRunner(
    store,
    {
      execute: async () => {
        calls += 1;
        throw new Error('provider down');
      },
    },
    { providerFailureRetries: 0 },
  );
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    tickets: [{ path: '/tmp/ticket.md', feature: 'feat', issueName: 'pf', label: 'feat/pf', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' },
  };

  await runner.launch(plan as never);
  assert.equal(calls, 1);
});

test('hands off when per-phase wall clock budget is exceeded', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-budget-phase-'));
  let tick = 0;
  const store = new RuntimeStore({ repoRoot, now: () => tick++ * 10 });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, 'Status: ready-for-agent\n');
  const runner = new SingleTicketRunner(
    store,
    {
      execute: async ({ invocationMode }) =>
        invocationMode === 'reviewer'
          ? {
              status: 'completed',
              sessionId: 's-review',
              output: [JSON.stringify({ done: true, summary: 'ok', findings: [] })],
            }
          : { status: 'completed', sessionId: 's-exec' },
    },
    { phaseWallClockMs: { execution: 5 } },
  );
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [{ path: ticketPath, feature: 'feat', issueName: 'p1', label: 'feat/p1', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };

  await runner.launch(plan as never);
  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-p1.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
    STATUS: string;
    BUDGET_EXCEEDED_EVENTS?: Array<{ budgetName: string }>;
  };
  assert.equal(metadata.STATUS, 'blocked');
  assert.equal(metadata.BUDGET_EXCEEDED_EVENTS?.[0]?.budgetName, 'phase-execution-wall-clock-ms');
});

test('hands off when per-ticket wall clock budget is exceeded', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-budget-ticket-'));
  let nowValue = 0;
  const realDateNow = Date.now;
  Date.now = () => nowValue;
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, 'Status: ready-for-agent\n');
  const runner = new SingleTicketRunner(
    store,
    {
      execute: async ({ invocationMode }) => {
        nowValue += 20;
        return invocationMode === 'reviewer'
          ? {
              status: 'completed',
              sessionId: 's-review',
              output: [JSON.stringify({ done: true, summary: 'ok', findings: [] })],
            }
          : { status: 'completed', sessionId: 's-exec' };
      },
    },
    { ticketWallClockMs: 10 },
  );
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [{ path: ticketPath, feature: 'feat', issueName: 't1', label: 'feat/t1', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };

  try {
    await runner.launch(plan as never);
  } finally {
    Date.now = realDateNow;
  }
  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-t1.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
    STATUS: string;
    BUDGET_EXCEEDED_EVENTS?: Array<{ budgetName: string }>;
  };
  assert.equal(metadata.STATUS, 'blocked');
  assert.equal(metadata.BUDGET_EXCEEDED_EVENTS?.[0]?.budgetName, 'ticket-wall-clock-ms');
});

test('blocks launch when selected ticket path is missing', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-missing-path-'));
  const store = new RuntimeStore({ repoRoot });
  let executeCalls = 0;
  const runner = new SingleTicketRunner(store, {
    execute: async () => {
      executeCalls += 1;
      return { status: 'completed', sessionId: 'session-missing', removable: true };
    },
  });
  const ticketPath = path.join(repoRoot, '.scratch', 'feat', 'issues', '404.md');
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    tickets: [{ path: ticketPath, feature: 'feat', issueName: '404', label: 'feat/404', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' },
  };

  const result = await runner.launch(plan as never);

  assert.equal(result.scheduled, false);
  assert.equal(result.launchBlock?.kind, 'path-validation');
  assert.match(result.message, /Selected issue path missing/);
  assert.equal(executeCalls, 0);
});

test('blocks launch when selected ticket path is outside issues layout', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-layout-path-'));
  const store = new RuntimeStore({ repoRoot });
  let executeCalls = 0;
  const runner = new SingleTicketRunner(store, {
    execute: async () => {
      executeCalls += 1;
      return { status: 'completed', sessionId: 'session-layout', removable: true };
    },
  });
  const badPath = path.join(repoRoot, '.scratch', 'feat', 'notes', '001.md');
  mkdirSync(path.dirname(badPath), { recursive: true });
  writeFileSync(badPath, '# wrong layout\n');
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    tickets: [{ path: badPath, feature: 'feat', issueName: '001', label: 'feat/001', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' },
  };

  const result = await runner.launch(plan as never);

  assert.equal(result.scheduled, false);
  assert.equal(result.launchBlock?.kind, 'path-validation');
  assert.match(result.message, /Invalid selected issue path/);
  assert.equal(executeCalls, 0);
});

test('blocks launch when selected ticket path attempts traversal', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-traversal-path-'));
  const store = new RuntimeStore({ repoRoot });
  const runner = new SingleTicketRunner(store, { execute: async () => ({ status: 'completed' }) });
  const traversalPath = path.join(repoRoot, '.scratch', 'feat', 'issues', '..', 'notes', '002.md');
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    tickets: [{ path: traversalPath, feature: 'feat', issueName: '002', label: 'feat/002', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' },
  };

  const result = await runner.launch(plan as never);
  assert.equal(result.scheduled, false);
  assert.equal(result.launchBlock?.kind, 'path-validation');
  assert.match(result.message, /Invalid selected issue path/);
});

test('retries malformed reviewer output once before implementation fixup', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-reviewer-malformed-retry-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, 'Status: ready-for-agent\n\n## Title\n\nImplement the thing\n');
  const callOrder: string[] = [];
  let malformedRetryPrompt = '';
  let reviewerCalls = 0;
  let executionCalls = 0;
  const runner = new SingleTicketRunner(store, {
    execute: async ({ invocationMode, prompt }) => {
      if (invocationMode === 'reviewer') {
        reviewerCalls += 1;
        callOrder.push(`reviewer-${reviewerCalls}`);
        if (reviewerCalls === 1) {
          return { status: 'completed', sessionId: 'session-review', removable: true, output: ['not json'] };
        }
        if (reviewerCalls === 2) {
          malformedRetryPrompt = prompt;
          return {
            status: 'completed',
            sessionId: 'session-review',
            removable: true,
            output: [
              JSON.stringify({
                done: false,
                summary: 'Fix this',
                findings: [{ severity: 'major', title: 'Need fix', detail: 'Please update code' }],
              }),
            ],
          };
        }
        return {
          status: 'completed',
          sessionId: 'session-review',
          removable: true,
          output: [JSON.stringify({ done: true, summary: 'Looks good', findings: [] })],
        };
      }

      executionCalls += 1;
      callOrder.push(`execution-${executionCalls}`);
      if (executionCalls === 2) {
        writeFileSync(ticketPath, 'Status: done\n\n## Title\n\nImplement the thing\n\n## AFK Summary\n\nDone\n');
      }
      return {
        status: 'completed',
        sessionId: 'session-exec',
        removable: true,
        output: ['implementation pass complete'],
      };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [
      {
        path: ticketPath,
        feature: 'feat',
        issueName: 'malformed-retry',
        label: 'feat/malformed-retry',
        executorAfk: true,
      },
    ],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };

  await runner.launch(plan as never);

  assert.deepEqual(callOrder, ['execution-1', 'reviewer-1', 'reviewer-2', 'execution-2', 'reviewer-3']);
  assert.match(malformedRetryPrompt, /The previous reviewer response was malformed and could not be parsed\./);
  const logPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-malformed-retry.log');
  assert.match(readFileSync(logPath, 'utf8'), /malformed reviewer output retry 1\/2/);
});

test('hands off after repeated malformed reviewer output without implementation fixup', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-reviewer-malformed-handoff-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, 'Status: ready-for-agent\n\n## Title\n\nImplement the thing\n');
  const callOrder: string[] = [];
  const progress: string[] = [];
  const runner = new SingleTicketRunner(store, {
    execute: async ({ invocationMode }) => {
      if (invocationMode === 'reviewer') {
        callOrder.push('reviewer');
        return {
          status: 'completed',
          sessionId: 'session-review',
          removable: true,
          output: ['invalid reviewer output'],
        };
      }
      callOrder.push('execution');
      return {
        status: 'completed',
        sessionId: 'session-exec',
        removable: true,
        output: ['implementation pass complete'],
      };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [
      {
        path: ticketPath,
        feature: 'feat',
        issueName: 'malformed-handoff',
        label: 'feat/malformed-handoff',
        executorAfk: true,
      },
    ],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };

  await runner.launch(plan as never, { onProgress: (event) => progress.push(event.message) });

  assert.deepEqual(callOrder, ['execution', ...Array.from({ length: 3 }, () => 'reviewer')]);
  const metadataPath = path.join(
    repoRoot,
    '.scratch',
    '.opencode-afk-logs',
    'runtime-metadata',
    'feat-malformed-handoff.json',
  );
  const metadata = readFileSync(metadataPath, 'utf8');
  assert.match(metadata, /"STATUS": "blocked"/);
  assert.match(metadata, /"FAILURE_KIND": "reviewer-output-malformed"/);
  assert.match(metadata, /"FINAL_REVIEW_CLASSIFICATION": "malformed-output-handoff"/);
  assert.match(metadata, /"FINAL_REVIEW_FINDINGS": \[\]/);
  assert.match(metadata, /"FINAL_REVIEW_MALFORMED_OUTPUT_SNIPPET":/);
  const logPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-malformed-handoff.log');
  const log = readFileSync(logPath, 'utf8');
  assert.match(log, /malformed reviewer output retry 1\/2/);
  assert.match(log, /malformed reviewer output retry 2\/2/);
  assert.match(log, /malformed reviewer output handoff: reviewer-output-malformed/);
  assert.deepEqual(
    progress.filter((line) => line.startsWith('malformed reviewer output')),
    [
      ...Array.from({ length: 2 }, (_, index) => `malformed reviewer output retry ${index + 1}/2`),
      'malformed reviewer output handoff',
    ],
  );
});

test('reviewer prompt includes updated ticket content after execution edits', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-reviewer-ticket-content-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, '---\nstatus: ready-for-agent\n---\n\n## Title\n\nDo the thing\n');
  let reviewerPrompt = '';
  const runner = new SingleTicketRunner(store, {
    execute: async ({ prompt, invocationMode }) => {
      if (invocationMode === 'reviewer') {
        reviewerPrompt = prompt;
        return {
          status: 'completed',
          sessionId: 'session-review',
          removable: true,
          output: [JSON.stringify({ done: true, summary: 'Clean pass', findings: [] })],
        };
      }
      writeFileSync(ticketPath, '---\nstatus: done\n---\n\n## Title\n\nDo the thing\n\n## AFK Summary\n\nCompleted.\n');
      return { status: 'completed', sessionId: 'session-exec', removable: true, output: ['done'] };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [{ path: ticketPath, feature: 'feat', issueName: 'rt', label: 'feat/rt', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };

  await runner.launch(plan as never);

  assert.match(reviewerPrompt, /Updated ticket content:/);
  assert.match(reviewerPrompt, /status: done/);
  assert.match(reviewerPrompt, /## AFK Summary/);
  assert.match(reviewerPrompt, /Completed\./);
});

test('updated ticket content appears before execution output in reviewer prompt', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-reviewer-ticket-order-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, '---\nstatus: ready-for-agent\n---\n\n## Title\n\nDo the thing\n');
  let reviewerPrompt = '';
  const runner = new SingleTicketRunner(store, {
    execute: async ({ prompt, invocationMode }) => {
      if (invocationMode === 'reviewer') {
        reviewerPrompt = prompt;
        return {
          status: 'completed',
          sessionId: 'session-review',
          removable: true,
          output: [JSON.stringify({ done: true, summary: 'Clean pass', findings: [] })],
        };
      }
      writeFileSync(ticketPath, '---\nstatus: done\n---\n\n## Title\n\nDo the thing\n\n## AFK Summary\n\nDone.\n');
      return {
        status: 'completed',
        sessionId: 'session-exec',
        removable: true,
        output: ['execution line 1', 'execution line 2'],
      };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [{ path: ticketPath, feature: 'feat', issueName: 'ro', label: 'feat/ro', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };

  await runner.launch(plan as never);

  const updatedTicketIndex = reviewerPrompt.indexOf('Updated ticket content:');
  const executionOutputIndex = reviewerPrompt.indexOf('Execution output:');
  assert.notEqual(updatedTicketIndex, -1);
  assert.notEqual(executionOutputIndex, -1);
  assert.ok(updatedTicketIndex < executionOutputIndex, 'updated ticket content should appear before execution output');
});

test('second reviewer prompt after fixup includes latest ticket text from disk', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-reviewer-fixup-ticket-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, '---\nstatus: ready-for-agent\n---\n\n## Title\n\nDo the thing\n');
  const reviewerPrompts: string[] = [];
  let reviewerCalls = 0;
  let executionCalls = 0;
  const runner = new SingleTicketRunner(store, {
    execute: async ({ prompt, invocationMode }) => {
      if (invocationMode === 'reviewer') {
        reviewerCalls += 1;
        reviewerPrompts.push(prompt);
        return {
          status: 'completed',
          sessionId: 'session-review',
          removable: true,
          output: [
            JSON.stringify(
              reviewerCalls === 1
                ? {
                    done: false,
                    summary: 'Needs fix',
                    findings: [{ severity: 'major', title: 'Bug', detail: 'Fix it' }],
                  }
                : { done: true, summary: 'Looks good', findings: [] },
            ),
          ],
        };
      }
      executionCalls += 1;
      if (executionCalls === 2) {
        writeFileSync(
          ticketPath,
          '---\nstatus: done\n---\n\n## Title\n\nDo the thing\n\n## AFK Summary\n\nFixup complete.\n',
        );
      }
      return {
        status: 'completed',
        sessionId: 'session-exec',
        removable: true,
        output: ['implementation pass complete'],
      };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [{ path: ticketPath, feature: 'feat', issueName: 'rf', label: 'feat/rf', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };

  await runner.launch(plan as never);

  assert.equal(reviewerCalls, 2);
  assert.equal(reviewerPrompts.length, 2);
  assert.match(reviewerPrompts[0], /status: ready-for-agent/);
  assert.doesNotMatch(reviewerPrompts[0], /Fixup complete\./);
  assert.match(reviewerPrompts[1], /status: done/);
  assert.match(reviewerPrompts[1], /Fixup complete\./);
});

test('blocks run without reviewer invocation when updated ticket cannot be read before review', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-reviewer-ticket-read-fail-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, '---\nstatus: ready-for-agent\n---\n\n## Title\n\nDo the thing\n');
  let reviewerCalls = 0;
  const runner = new SingleTicketRunner(store, {
    execute: async ({ invocationMode }) => {
      if (invocationMode === 'reviewer') {
        reviewerCalls += 1;
        return {
          status: 'completed',
          sessionId: 'session-review',
          removable: true,
          output: [JSON.stringify({ done: true, summary: 'Clean pass', findings: [] })],
        };
      }
      // Delete the ticket file during execution so the pre-review read fails
      try {
        unlinkSync(ticketPath);
      } catch {}
      return { status: 'completed', sessionId: 'session-exec', removable: true, output: ['done'] };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [{ path: ticketPath, feature: 'feat', issueName: 'trf', label: 'feat/trf', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };

  const result = await runner.launch(plan as never);

  assert.equal(reviewerCalls, 0);
  assert.equal(result.outcome, 'blocked');
  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-trf.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
    STATUS: string;
    FAILURE_KIND?: string;
    UNSAFE_REASON?: string;
  };
  assert.equal(metadata.STATUS, 'blocked');
  assert.equal(metadata.FAILURE_KIND, 'ticket-read-failure');
  assert.match(metadata.UNSAFE_REASON ?? '', /updated ticket context could not be read before review/);
  const logPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-trf.log');
  assert.match(readFileSync(logPath, 'utf8'), /updated ticket context could not be read before review/);
});

test('reviewer prompt includes exact target context when snapshot is available', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-reviewer-target-ctx-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, 'Status: done\n\n## AFK Summary\n\nDone\n');
  let reviewerPrompt = '';
  const runner = new SingleTicketRunner(store, {
    execute: async ({ prompt, invocationMode }) => {
      if (invocationMode === 'reviewer') {
        reviewerPrompt = prompt;
        return {
          status: 'completed',
          sessionId: 'session-review',
          removable: true,
          output: [JSON.stringify({ done: true, summary: 'Clean pass', findings: [] })],
        };
      }
      return { status: 'completed', sessionId: 'session-exec', removable: true };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' },
    tickets: [{ path: ticketPath, feature: 'feat', issueName: 'rtc', label: 'feat/rtc', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
    snapshots: {
      'feat/rtc': {
        generatedAt: 'now',
        ticketLabel: 'feat/rtc',
        ticketStatus: 'done',
        ticketIssueName: 'rtc',
        featureSlug: 'feat',
        ticketPath,
        scratchFeaturePath: path.join(repoRoot, '.scratch', 'feat'),
        repoRoot,
        worktreePath: '/tmp/worktree',
        worktreeName: 'feat',
        branchName: 'feat',
        head: 'abc123def456',
        gitStatusShort: [],
        ticketOutsideWorktree: true,
        dependencies: [],
        readiness: null,
      },
    },
  };

  await runner.launch(plan as never);

  assert.match(reviewerPrompt, /## Review Target/);
  assert.match(reviewerPrompt, /Repo root: /);
  assert.match(reviewerPrompt, /Worktree path: \/tmp\/worktree/);
  assert.match(reviewerPrompt, /Branch: feat/);
  assert.doesNotMatch(reviewerPrompt, /Implementation HEAD:/);
  assert.match(reviewerPrompt, /Ticket path: /);
  assert.doesNotMatch(reviewerPrompt, /git rev-parse HEAD/);
  assert.match(reviewerPrompt, /worktree path or branch does not match/i);
  assert.match(reviewerPrompt, /targetMismatch":true/);
  assert.match(reviewerPrompt, /Do not request cosmetic fixup commits for stale or wrong-worktree findings/);
});

test('hands off without fixup when reviewer reports target mismatch', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-target-mismatch-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, 'Status: done\n\n## AFK Summary\n\nDone\n');
  let executionCalls = 0;
  let reviewerCalls = 0;
  const runner = new SingleTicketRunner(store, {
    execute: async ({ invocationMode }) => {
      if (invocationMode === 'reviewer') {
        reviewerCalls += 1;
        return {
          status: 'completed',
          sessionId: 'session-review',
          removable: true,
          output: [
            JSON.stringify({
              done: false,
              summary: 'Review target mismatch: HEAD is stale',
              targetMismatch: true,
              findings: [],
            }),
          ],
        };
      }
      executionCalls += 1;
      return { status: 'completed', sessionId: 'session-exec', removable: true };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' },
    tickets: [{ path: ticketPath, feature: 'feat', issueName: 'tm', label: 'feat/tm', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };

  const result = await runner.launch(plan as never);

  assert.equal(executionCalls, 1);
  assert.equal(reviewerCalls, 1);
  assert.equal(result.outcome, 'blocked');
  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-tm.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
    STATUS: string;
    FAILURE_KIND?: string;
    FINAL_REVIEW_OUTCOME?: string;
    FINAL_REVIEW_CLASSIFICATION?: string;
    REVIEW_CYCLE_HISTORY?: Array<{ classification?: string }>;
  };
  assert.equal(metadata.STATUS, 'blocked');
  assert.equal(metadata.FAILURE_KIND, 'review-target-mismatch');
  assert.equal(metadata.FINAL_REVIEW_OUTCOME, 'needs-human');
  assert.equal(metadata.FINAL_REVIEW_CLASSIFICATION, 'review-target-mismatch');
  assert.equal(metadata.REVIEW_CYCLE_HISTORY?.[0]?.classification, 'review-target-mismatch');
  const logPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-tm.log');
  assert.match(readFileSync(logPath, 'utf8'), /review target mismatch handoff: review-target-mismatch/);
});

test('preserves implementation success when reviewer provider fails deterministically', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-review-handoff-'));
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, 'Status: done\n\n## AFK Summary\n\nDone\n');
  let executionCalls = 0;
  let reviewCalls = 0;
  const runner = new SingleTicketRunner(
    store,
    {
      execute: async ({ invocationMode }) => {
        if (invocationMode === 'reviewer') {
          reviewCalls += 1;
          return {
            status: 'failed',
            sessionId: `s-review-${reviewCalls}`,
            unsafeReason: 'The requested model is not available for integrator "copilot-language-server".',
            output: ['The requested model is not available for integrator "copilot-language-server".'],
          };
        }
        executionCalls += 1;
        return { status: 'completed', sessionId: 's-exec' };
      },
    },
    { providerFailureRetries: 5, deterministicProviderFailureRetries: 2 },
  );
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [
      {
        path: ticketPath,
        feature: 'feat',
        issueName: 'review-handoff',
        label: 'feat/review-handoff',
        executorAfk: true,
      },
    ],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };

  const result = await runner.launch(plan as never);

  assert.equal(executionCalls, 1);
  assert.equal(reviewCalls, 2);
  assert.equal(result.outcome, 'handoff');
  const metadataPath = path.join(
    repoRoot,
    '.scratch',
    '.opencode-afk-logs',
    'runtime-metadata',
    'feat-review-handoff.json',
  );
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
    STATUS: string;
    IMPLEMENTATION_STATUS?: string;
    REVIEW_STATUS?: string;
    RUN_STATUS?: string;
    FAILURE_KIND?: string;
    DETERMINISTIC_PROVIDER_FAILURE?: boolean;
    PROVIDER_FAILURE_KIND?: string;
    PROVIDER_FAILURE_SOURCE?: string;
  };
  assert.equal(metadata.STATUS, 'blocked');
  assert.equal(metadata.IMPLEMENTATION_STATUS, 'completed');
  assert.equal(metadata.REVIEW_STATUS, 'failed');
  assert.equal(metadata.RUN_STATUS, 'handoff');
  assert.equal(metadata.FAILURE_KIND, 'model-unavailable');
  assert.equal(metadata.DETERMINISTIC_PROVIDER_FAILURE, true);
  assert.equal(metadata.PROVIDER_FAILURE_KIND, 'model-unavailable');
  assert.equal(metadata.PROVIDER_FAILURE_SOURCE, 'provider-error');
  assert.equal(
    existsSync(path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'sentinels', 'feat-review-handoff.handoff')),
    true,
  );
});

test('short-circuits deterministic provider launch failures after small retry budget', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-deterministic-short-circuit-'));
  const store = new RuntimeStore({ repoRoot });
  let calls = 0;
  const runner = new SingleTicketRunner(
    store,
    {
      execute: async () => {
        calls += 1;
        throw new Error('The requested model is not available for integrator "copilot-language-server".');
      },
    },
    { providerFailureRetries: 10, deterministicProviderFailureRetries: 2 },
  );
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    tickets: [{ path: '/tmp/ticket.md', feature: 'feat', issueName: 'det', label: 'feat/det', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' },
  };

  const result = await runner.launch(plan as never);

  assert.equal(calls, 2);
  assert.equal(result.outcome, 'failed');
  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-det.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
    DETERMINISTIC_PROVIDER_FAILURE?: boolean;
    FAILURE_KIND?: string;
    IMPLEMENTATION_STATUS?: string;
    RUN_STATUS?: string;
  };
  assert.equal(metadata.DETERMINISTIC_PROVIDER_FAILURE, true);
  assert.equal(metadata.FAILURE_KIND, 'model-unavailable');
  assert.equal(metadata.IMPLEMENTATION_STATUS, 'failed');
  assert.equal(metadata.RUN_STATUS, 'failed');
});

test('does not classify provider failures from ordinary assistant prose', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-prose-safety-'));
  const store = new RuntimeStore({ repoRoot });
  const runner = new SingleTicketRunner(
    store,
    {
      execute: async () => {
        return {
          status: 'failed',
          sessionId: 's-exec',
          unsafeReason: null,
          output: ['I was thinking about the model_not_available_for_integrator error but it is not a real failure.'],
        };
      },
    },
    { providerFailureRetries: 0 },
  );
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    tickets: [{ path: '/tmp/ticket.md', feature: 'feat', issueName: 'prose', label: 'feat/prose', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: 'src/prompts/reviewer-default.md' },
  };

  await runner.launch(plan as never);

  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-prose.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
    FAILURE_KIND?: string;
    PROVIDER_FAILURE_KIND?: string;
    PROVIDER_FAILURE_SOURCE?: string;
  };
  assert.equal(metadata.FAILURE_KIND, 'unknown');
  assert.equal(metadata.PROVIDER_FAILURE_KIND, 'unknown');
  assert.equal(metadata.PROVIDER_FAILURE_SOURCE, 'unknown');
});

test('budget handoff preserves implementation success when execution completed', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-budget-handoff-'));
  let tick = 0;
  const store = new RuntimeStore({ repoRoot, now: () => tick++ * 10 });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, 'Status: ready-for-agent\n');
  const runner = new SingleTicketRunner(
    store,
    {
      execute: async ({ invocationMode }) =>
        invocationMode === 'reviewer'
          ? {
              status: 'completed',
              sessionId: 's-review',
              output: [JSON.stringify({ done: true, summary: 'ok', findings: [] })],
            }
          : { status: 'completed', sessionId: 's-exec' },
    },
    { phaseWallClockMs: { execution: 5 } },
  );
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [{ path: ticketPath, feature: 'feat', issueName: 'bh', label: 'feat/bh', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath: '/tmp/worktree',
    },
  };

  await runner.launch(plan as never);
  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-bh.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
    STATUS: string;
    IMPLEMENTATION_STATUS?: string;
    RUN_STATUS?: string;
    BUDGET_EXCEEDED_EVENTS?: Array<{ budgetName: string }>;
  };
  assert.equal(metadata.STATUS, 'blocked');
  assert.equal(metadata.IMPLEMENTATION_STATUS, 'completed');
  assert.equal(metadata.RUN_STATUS, 'handoff');
  assert.equal(metadata.BUDGET_EXCEEDED_EVENTS?.[0]?.budgetName, 'phase-execution-wall-clock-ms');
  assert.equal(existsSync(path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'sentinels', 'feat-bh.handoff')), true);
});

test('does not run static check commands or inject static check output into reviewer prompt', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-static-checks-disabled-'));
  const worktreePath = mkdtempSync(path.join(tmpdir(), 'afk-runner-static-checks-disabled-worktree-'));
  writeFileSync(
    path.join(repoRoot, 'afk.json'),
    JSON.stringify({ testsEnabled: false, staticCheckCommands: ['echo pass', 'echo fail >&2; exit 1'] }),
  );
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, 'Status: done\n\n## AFK Summary\n\nDone\n');
  let reviewerPrompt = '';
  let staticCheckCalls = 0;
  const runner = new SingleTicketRunner(
    store,
    {
      execute: async ({ prompt, invocationMode }) => {
        if (invocationMode === 'reviewer') {
          reviewerPrompt = prompt;
          return {
            status: 'completed',
            sessionId: 'session-review',
            removable: true,
            output: [JSON.stringify({ done: true, summary: 'Clean pass', findings: [] })],
          };
        }
        return { status: 'completed', sessionId: 'session-exec', removable: true, output: ['done'] };
      },
    },
    {},
    {
      run: () => {
        staticCheckCalls += 1;
        return { exitCode: 0, output: '' };
      },
    },
  );
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [{ path: ticketPath, feature: 'feat', issueName: 'sc', label: 'feat/sc', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath,
    },
  };

  await runner.launch(plan as never);

  assert.equal(staticCheckCalls, 0);
  const logPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-sc.log');
  const log = readFileSync(logPath, 'utf8');
  assert.doesNotMatch(log, /static check:/);
  assert.doesNotMatch(reviewerPrompt, /Static check results:/);
});

test('reviewer repair prompt omits static check results', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runner-static-repair-no-inject-'));
  const worktreePath = mkdtempSync(path.join(tmpdir(), 'afk-runner-static-repair-no-inject-worktree-'));
  writeFileSync(
    path.join(repoRoot, 'afk.json'),
    JSON.stringify({ testsEnabled: false, staticCheckCommands: ['echo fail >&2; exit 1'] }),
  );
  const store = new RuntimeStore({ repoRoot });
  const ticketPath = path.join(repoRoot, 'ticket.md');
  writeFileSync(ticketPath, 'Status: ready-for-agent\n\n## Title\n\nDo thing\n');
  let repairPrompt = '';
  let reviewerCalls = 0;
  const runner = new SingleTicketRunner(store, {
    execute: async ({ prompt, invocationMode }) => {
      if (invocationMode === 'reviewer') {
        reviewerCalls += 1;
        if (reviewerCalls === 1) {
          repairPrompt = prompt;
          return { status: 'completed', sessionId: 'session-review', removable: true, output: ['not json'] };
        }
        return {
          status: 'completed',
          sessionId: 'session-review',
          removable: true,
          output: [JSON.stringify({ done: true, summary: 'Clean pass', findings: [] })],
        };
      }
      return { status: 'completed', sessionId: 'session-exec', removable: true, output: ['done'] };
    },
  });
  const plan = {
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: resolveReviewerPromptTemplate(),
    tickets: [{ path: ticketPath, feature: 'feat', issueName: 'sr', label: 'feat/sr', executorAfk: true }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat',
      effectiveWorktreeName: 'feat',
      defaultBranchName: 'feat',
      effectiveBranchName: 'feat',
      worktreePath,
    },
  };

  await runner.launch(plan as never);

  assert.equal(reviewerCalls, 2);
  assert.doesNotMatch(repairPrompt, /Static check results:/);
  assert.doesNotMatch(repairPrompt, /echo fail >&2; exit 1/);
});
