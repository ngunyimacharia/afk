import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeAgentExecutionProvider, OpenCodeAgentExecutionProvider } from '../src/agent-execution-provider.js';

test('normalizes execution outcomes and session ids', async () => {
  const provider = new FakeAgentExecutionProvider({ status: 'failed', sessionId: 'abc', removable: false, unsafeReason: 'sdk session id unavailable' });
  const result = await provider.execute({ plan: undefined as never, ticketIndex: 0, prompt: '' });
  assert.equal(result.status, 'failed');
  assert.equal(result.sessionId, 'abc');
  assert.equal(result.removable, false);
  assert.equal(result.unsafeReason, 'sdk session id unavailable');
});

test('captures interrupted and unknown outcomes without mutation', async () => {
  const provider = new FakeAgentExecutionProvider({ status: 'interrupted', sessionId: null, removable: true, output: ['stopping'] });
  const result = await provider.execute({ plan: undefined as never, ticketIndex: 1, prompt: 'run' });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.sessionId, null);
  assert.equal(result.removable, true);
  assert.deepEqual(result.output, ['stopping']);
});

test('opencode provider maps successful execution to completed result', async () => {
  let capturedAgent = '';
  let capturedTitle = '';
  const progress: string[] = [];
  const provider = new OpenCodeAgentExecutionProvider({
    run: async (input) => {
      capturedAgent = input.agent ?? '';
      capturedTitle = input.title;
      input.onProgress?.({ message: 'created opencode session session-42', sessionId: 'session-42' });
      return { sessionId: 'session-42', output: ['ok'] };
    },
  });
  const result = await provider.execute({
    plan: { tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
    onProgress: (event) => progress.push(`${event.ticketLabel}: ${event.message}`),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.sessionId, 'session-42');
  assert.equal(result.removable, true);
  assert.equal(capturedAgent, 'build');
  assert.equal(capturedTitle, 'afk: feat/01');
  assert.deepEqual(progress, [
    'feat/01: starting opencode session',
    'feat/01: created opencode session session-42',
    'feat/01: opencode session completed',
  ]);
});

test('opencode provider maps executor failures to failed status', async () => {
  const provider = new OpenCodeAgentExecutionProvider({
    run: async () => {
      throw new Error('sdk exploded');
    },
  });
  const result = await provider.execute({
    plan: { tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
  });
  assert.equal(result.status, 'failed');
  assert.match(result.unsafeReason ?? '', /sdk exploded/);
});

test('opencode provider maps model availability output to failed status', async () => {
  const provider = new OpenCodeAgentExecutionProvider({
    run: async () => ({
      sessionId: 'session-model-error',
      output: ['The requested model is not available for integrator "copilot-language-server".'],
    }),
  });

  const result = await provider.execute({
    plan: { tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.sessionId, 'session-model-error');
  assert.equal(result.removable, false);
  assert.match(result.unsafeReason ?? '', /requested model is not available/);
  assert.deepEqual(result.output, ['The requested model is not available for integrator "copilot-language-server".']);
});
