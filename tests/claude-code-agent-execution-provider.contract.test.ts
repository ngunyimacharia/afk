import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeAgentExecutionProvider } from '../src/agent-execution-provider.js';

test('claude provider maps successful execution to completed result', async () => {
  let capturedTitle = '';
  const progress: string[] = [];
  const provider = new ClaudeAgentExecutionProvider({
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
    'feat/02: starting claude session',
    'feat/02: created claude session session-99',
    'feat/02: claude session completed',
  ]);
});

test('claude provider maps executor failures to failed status', async () => {
  const provider = new ClaudeAgentExecutionProvider({
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

test('claude provider detects claude-specific failures', async () => {
  const progress: string[] = [];
  const provider = new ClaudeAgentExecutionProvider({
    run: async () => ({
      sessionId: 'session-claude-error',
      output: ['claude error: rate_limit_error'],
    }),
  });

  const result = await provider.execute({
    plan: { model: { id: 'kimi/kimi-for-coding' }, tickets: [{ label: 'feat/01' }] } as never,
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

test('claude provider forwards permission progress events', async () => {
  const progress: string[] = [];
  const provider = new ClaudeAgentExecutionProvider({
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
    'message:feat/01:starting claude session',
    'permission:feat/01:claude permission denied: bash - not allowed',
    'message:feat/01:claude session completed',
  ]);
});
