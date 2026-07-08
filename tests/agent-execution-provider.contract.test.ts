import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertCommandAllowed,
  CompositeAgentExecutionProvider,
  decideAfkPermission,
  FakeAgentExecutionProvider,
  isCommandAllowed,
  resolveAgentInvocationPolicy,
} from '../src/agent-execution-provider.js';
import { SandcastleAgentExecutionProvider } from '../src/sandcastle-agent-execution-provider.js';

test('fake provider returns configured execution outcomes', async () => {
  const provider = new FakeAgentExecutionProvider({
    status: 'failed',
    sessionId: 'abc',
    removable: false,
    unsafeReason: 'provider unavailable',
  });

  const result = await provider.execute({ plan: undefined as never, ticketIndex: 0, prompt: '' });

  assert.equal(result.status, 'failed');
  assert.equal(result.sessionId, 'abc');
  assert.equal(result.removable, false);
  assert.equal(result.unsafeReason, 'provider unavailable');
});

test('reviewer and pull-request policies constrain mutation commands', () => {
  const reviewer = resolveAgentInvocationPolicy('reviewer');
  const pullRequest = resolveAgentInvocationPolicy('pull-request');

  assert.equal(isCommandAllowed(reviewer, { kind: 'scratch-write' }), true);
  assert.equal(isCommandAllowed(reviewer, { kind: 'edit' }), false);
  assert.equal(isCommandAllowed(pullRequest, { kind: 'github-pr' }), true);
  assert.throws(() => assertCommandAllowed(pullRequest, { kind: 'scratch-write' }), /Pull-request mode blocks/);
});

test('permission decisions enforce pull-request policy', async () => {
  const request = { type: 'bash', title: 'bash', patterns: ['apply_patch'], sessionId: 's1', permissionId: 'p1' };

  const decision = await decideAfkPermission(request, {
    policy: resolveAgentInvocationPolicy('pull-request'),
  });

  assert.equal(decision, 'reject');
});

test('composite provider routes reviewer invocations to reviewer provider', async () => {
  const implementation = new FakeAgentExecutionProvider({ status: 'completed', sessionId: 'impl', removable: true });
  const reviewer = new FakeAgentExecutionProvider({ status: 'completed', sessionId: 'review', removable: true });
  const composite = new CompositeAgentExecutionProvider(implementation, reviewer);

  const result = await composite.execute({
    plan: undefined as never,
    ticketIndex: 0,
    prompt: '',
    invocationMode: 'reviewer',
  });

  assert.equal(result.sessionId, 'review');
});

test('sandcastle provider hands current phase to Sandcastle execution client', async () => {
  const seen: string[] = [];
  const provider = new SandcastleAgentExecutionProvider({
    execute: async ({ request, provider }) => {
      seen.push(`${request.invocationMode ?? 'execution'}:${provider?.provider ?? 'missing'}`);
      return { status: 'completed', sessionId: 'sandcastle-run', removable: true };
    },
  });

  const result = await provider.execute({
    plan: {
      tickets: [{ label: 'feature/001' }],
      sandcastleProvider: {
        provider: 'codex',
        docker: { env: [], mounts: [] },
        noSandbox: { enabled: true, reason: 'test' },
      },
      reviewerSandcastleProvider: {
        provider: 'claudeCode',
        docker: { env: [], mounts: [] },
        noSandbox: { enabled: true, reason: 'test' },
      },
    } as never,
    ticketIndex: 0,
    prompt: 'review',
    invocationMode: 'reviewer',
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(seen, ['reviewer:claudeCode']);
});

test('sandcastle provider dispatches PI execution plans to pi provider', async () => {
  const seen: string[] = [];
  const provider = new SandcastleAgentExecutionProvider({
    execute: async ({ request, provider: sel }) => {
      seen.push(`${request.invocationMode ?? 'execution'}:${sel?.provider ?? 'missing'}`);
      return { status: 'completed', sessionId: 'pi-exec-run', removable: true };
    },
  });

  await provider.execute({
    plan: {
      tickets: [{ label: 'feature/pi-01' }],
      sandcastleProvider: {
        provider: 'pi',
        docker: { env: [], mounts: [] },
        noSandbox: { enabled: true, reason: 'test' },
      },
    } as never,
    ticketIndex: 0,
    prompt: 'implement',
  });

  assert.deepEqual(seen, ['execution:pi']);
});

test('sandcastle provider routes PI reviewer invocations to pi provider independently', async () => {
  const seen: string[] = [];
  const provider = new SandcastleAgentExecutionProvider({
    execute: async ({ request, provider: sel }) => {
      seen.push(`${request.invocationMode ?? 'execution'}:${sel?.provider ?? 'missing'}`);
      return { status: 'completed', sessionId: 'pi-review-run', removable: true };
    },
  });

  await provider.execute({
    plan: {
      tickets: [{ label: 'feature/pi-02' }],
      sandcastleProvider: {
        provider: 'codex',
        docker: { env: [], mounts: [] },
        noSandbox: { enabled: true, reason: 'test' },
      },
      reviewerSandcastleProvider: {
        provider: 'pi',
        docker: { env: [], mounts: [] },
        noSandbox: { enabled: true, reason: 'test' },
      },
    } as never,
    ticketIndex: 0,
    prompt: 'review',
    invocationMode: 'reviewer',
  });

  assert.deepEqual(seen, ['reviewer:pi']);
});

test('sandcastle provider blocks clearly when no execution client is configured', async () => {
  const provider = new SandcastleAgentExecutionProvider();

  const result = await provider.execute({
    plan: { tickets: [{ label: 'feature/001' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
  });

  assert.equal(result.status, 'blocked');
  assert.match(result.unsafeReason ?? '', /Sandcastle execution execution client is not configured/);
});
