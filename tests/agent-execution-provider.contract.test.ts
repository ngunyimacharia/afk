import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FakeAgentExecutionProvider,
  assertCommandAllowed,
  resolveAgentInvocationPolicy,
} from '../src/agent-execution-provider.js';

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

test('defaults to execution mode and keeps mutation capabilities available', () => {
  const policy = resolveAgentInvocationPolicy();

  assert.equal(policy.mode, 'execution');
  assert.equal(policy.canMutateWorkspace, true);
  assert.equal(policy.canMutateGitState, true);
  assert.equal(policy.canMutateScratch, true);
  assert.deepEqual(policy.allowedCommandKinds, ['read', 'diagnostic', 'write', 'edit', 'delete', 'git-commit', 'git-push', 'scratch-write']);
  assert.doesNotThrow(() => assertCommandAllowed(policy, { kind: 'git-push', target: 'origin/main' }));
});

test('reviewer mode only allows read-only diagnostics', () => {
  const policy = resolveAgentInvocationPolicy('reviewer');

  assert.equal(policy.mode, 'reviewer');
  assert.equal(policy.canMutateWorkspace, false);
  assert.equal(policy.canMutateGitState, false);
  assert.equal(policy.canMutateScratch, false);
  assert.deepEqual(policy.allowedCommandKinds, ['read', 'diagnostic']);
  assert.doesNotThrow(() => assertCommandAllowed(policy, { kind: 'read', target: '.scratch/feat/issues/01.md' }));
  assert.doesNotThrow(() => assertCommandAllowed(policy, { kind: 'diagnostic', target: 'git status' }));
  assert.throws(() => assertCommandAllowed(policy, { kind: 'write', target: 'src/index.ts' }), /Reviewer mode blocks write commands/);
  assert.throws(() => assertCommandAllowed(policy, { kind: 'git-commit', target: 'fix review findings' }), /Reviewer mode blocks git-commit commands/);
  assert.throws(() => assertCommandAllowed(policy, { kind: 'delete', target: '.scratch/feat/issues/01.md' }), /Reviewer mode blocks delete commands/);
});
