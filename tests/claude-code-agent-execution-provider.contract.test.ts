import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ClaudeAnthropicAgentExecutionProvider,
  ClaudeKimiAgentExecutionProvider,
} from '../src/agent-execution-provider.js';

test('claude-anthropic provider maps successful execution to completed result', async () => {
  let capturedTitle = '';
  let capturedWorkDir: string | undefined;
  const progress: string[] = [];
  const provider = new ClaudeAnthropicAgentExecutionProvider({
    run: async (input) => {
      capturedTitle = input.title;
      capturedWorkDir = input.workDir;
      input.onProgress?.({ message: 'created claude session session-42', sessionId: 'session-42' });
      return { sessionId: 'session-42', output: ['ok'] };
    },
  });
  const result = await provider.execute({
    plan: {
      model: { id: 'anthropic/claude-sonnet-4-6' },
      tickets: [{ label: 'feat/01' }],
      checkout: { worktreePath: '/repo/.worktree/feat' },
    } as never,
    ticketIndex: 0,
    prompt: 'run',
    onProgress: (event) => progress.push(`${event.ticketLabel}: ${event.message}`),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.sessionId, 'session-42');
  assert.equal(result.removable, true);
  assert.equal(capturedTitle, 'afk: feat/01');
  assert.equal(capturedWorkDir, '/repo/.worktree/feat');
  assert.deepEqual(progress, [
    'feat/01: starting claude-anthropic session',
    'feat/01: created claude session session-42',
    'feat/01: claude-anthropic session completed',
  ]);
});

test('claude-kimi provider maps successful execution to completed result', async () => {
  let capturedTitle = '';
  const progress: string[] = [];
  const provider = new ClaudeKimiAgentExecutionProvider({
    run: async (input) => {
      capturedTitle = input.title;
      input.onProgress?.({ message: 'created claude session session-99', sessionId: 'session-99' });
      return { sessionId: 'session-99', output: ['ok'] };
    },
  });
  const result = await provider.execute({
    plan: {
      model: { id: 'kimi/kimi-for-coding' },
      tickets: [{ label: 'feat/02' }],
      checkout: { worktreePath: '/repo/.worktree/feat' },
    } as never,
    ticketIndex: 0,
    prompt: 'run',
    onProgress: (event) => progress.push(`${event.ticketLabel}: ${event.message}`),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.sessionId, 'session-99');
  assert.equal(capturedTitle, 'afk: feat/02');
  assert.deepEqual(progress, [
    'feat/02: starting claude-kimi session',
    'feat/02: created claude session session-99',
    'feat/02: claude-kimi session completed',
  ]);
});

test('claude-anthropic reviewer invocation does not set agent', async () => {
  let capturedAgent: string | undefined = 'unset';
  const provider = new ClaudeAnthropicAgentExecutionProvider({
    run: async (input) => {
      capturedAgent = input.agent;
      return { sessionId: 'session-review', output: ['{"summary":"ok","findings":[]}'] };
    },
  });

  const result = await provider.execute({
    plan: {
      model: { id: 'anthropic/claude-sonnet-4-6' },
      reviewerModel: { id: 'anthropic/claude-sonnet-4-6' },
      tickets: [{ label: 'feat/01' }],
    } as never,
    ticketIndex: 0,
    prompt: 'review',
    invocationMode: 'reviewer',
  });

  assert.equal(capturedAgent, undefined);
  assert.equal(result.status, 'completed');
});

test('claude-anthropic execution resumes existing session when provided', async () => {
  let capturedSessionId: string | null | undefined;
  const provider = new ClaudeAnthropicAgentExecutionProvider({
    run: async (input) => {
      capturedSessionId = input.sessionId;
      return { sessionId: 'session-existing', output: ['ok'] };
    },
  });

  await provider.execute({
    plan: { model: { id: 'anthropic/claude-sonnet-4-6' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'continue',
    invocationMode: 'execution',
    sessionId: 'session-existing',
  });

  assert.equal(capturedSessionId, 'session-existing');
});

test('claude-anthropic reviewer does not resume implementation session', async () => {
  let capturedSessionId: string | null | undefined = 'unset';
  const provider = new ClaudeAnthropicAgentExecutionProvider({
    run: async (input) => {
      capturedSessionId = input.sessionId;
      return { sessionId: 'session-review', output: ['{"summary":"ok","findings":[]}'] };
    },
  });

  await provider.execute({
    plan: {
      model: { id: 'anthropic/claude-sonnet-4-6' },
      reviewerModel: { id: 'anthropic/claude-sonnet-4-6' },
      tickets: [{ label: 'feat/01' }],
    } as never,
    ticketIndex: 0,
    prompt: 'review',
    invocationMode: 'reviewer',
    sessionId: 'session-existing',
  });

  assert.equal(capturedSessionId, null);
});

test('claude-anthropic provider maps executor failures to failed status', async () => {
  const provider = new ClaudeAnthropicAgentExecutionProvider({
    run: async () => {
      throw new Error('sdk exploded');
    },
  });
  const result = await provider.execute({
    plan: { model: { id: 'anthropic/claude-sonnet-4-6' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
  });
  assert.equal(result.status, 'failed');
  assert.match(result.unsafeReason ?? '', /sdk exploded/);
});

test('claude-kimi provider maps executor failures to failed status', async () => {
  const provider = new ClaudeKimiAgentExecutionProvider({
    run: async () => {
      throw new Error('kimi endpoint unreachable');
    },
  });
  const result = await provider.execute({
    plan: { model: { id: 'kimi/kimi-for-coding' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
  });
  assert.equal(result.status, 'failed');
  assert.match(result.unsafeReason ?? '', /kimi endpoint unreachable/);
});

test('claude-anthropic provider detects claude-specific failures', async () => {
  const progress: string[] = [];
  const provider = new ClaudeAnthropicAgentExecutionProvider({
    run: async () => ({
      sessionId: 'session-claude-error',
      output: ['claude error: rate_limit_error'],
    }),
  });

  const result = await provider.execute({
    plan: { model: { id: 'anthropic/claude-sonnet-4-6' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
    onProgress: (event) => progress.push(`${event.kind ?? 'message'}:${event.message}`),
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.sessionId, 'session-claude-error');
  assert.equal(result.removable, false);
  assert.match(result.unsafeReason ?? '', /claude error: rate_limit_error/);
  assert.match(progress.join('\n'), /failure:provider failure/);
});

test('claude-anthropic provider forwards permission progress events', async () => {
  const progress: string[] = [];
  const provider = new ClaudeAnthropicAgentExecutionProvider({
    run: async (input) => {
      input.onProgress?.({
        kind: 'permission',
        message: 'claude permission denied: bash - not allowed',
        sessionId: 'session-42',
      });
      return { sessionId: 'session-42', output: ['ok'] };
    },
  });

  await provider.execute({
    plan: { tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
    onProgress: (event) => progress.push(`${event.kind ?? 'message'}:${event.ticketLabel}:${event.message}`),
  });

  assert.deepEqual(progress, [
    'message:feat/01:starting claude-anthropic session',
    'permission:feat/01:claude permission denied: bash - not allowed',
    'message:feat/01:claude-anthropic session completed',
  ]);
});
