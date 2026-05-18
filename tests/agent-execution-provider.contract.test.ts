import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeAgentExecutionProvider } from '../src/agent-execution-provider.js';

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
