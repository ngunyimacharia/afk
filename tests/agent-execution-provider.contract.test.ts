import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideAfkPermission, FakeAgentExecutionProvider, OpenCodeAgentExecutionProvider } from '../src/agent-execution-provider.js';
import { PermissionCoordinator } from '../src/permission-coordinator.js';

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
    plan: { model: { id: 'github-copilot/claude-sonnet-4.6' }, tickets: [{ label: 'feat/01' }] } as never,
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
    plan: { model: { id: 'github-copilot/claude-sonnet-4.6' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
  });
  assert.equal(result.status, 'failed');
  assert.match(result.unsafeReason ?? '', /sdk exploded/);
});

test('opencode provider maps model availability output to failed status', async () => {
  const progress: string[] = [];
  const provider = new OpenCodeAgentExecutionProvider({
    run: async () => ({
      sessionId: 'session-model-error',
      output: ['The requested model is not available for integrator "copilot-language-server".'],
    }),
  });

  const result = await provider.execute({
    plan: { model: { id: 'github-copilot/claude-sonnet-4.6' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
    onProgress: (event) => progress.push(`${event.kind ?? 'message'}:${event.message}`),
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.sessionId, 'session-model-error');
  assert.equal(result.removable, false);
  assert.match(result.unsafeReason ?? '', /requested model is not available/);
  assert.deepEqual(result.output, ['The requested model is not available for integrator "copilot-language-server".']);
  assert.match(progress.join('\n'), /failure:provider failure: selected implementation model/);
});

test('opencode provider forwards permission progress events', async () => {
  const progress: string[] = [];
  const provider = new OpenCodeAgentExecutionProvider({
    run: async (input) => {
      input.onProgress?.({ kind: 'permission', message: 'opencode permission required: external_directory for /tmp/*; requested ask', sessionId: 'session-42', permissionId: 'per_1', permissionPatterns: ['/tmp/*'] });
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
    'message:feat/01:starting opencode session',
    'permission:feat/01:opencode permission required: external_directory for /tmp/*; requested ask',
    'message:feat/01:opencode session completed',
  ]);
});

test('opencode provider supplies AFK permission policy that allows repo-root external directories', async () => {
  let decision = '';
  const provider = new OpenCodeAgentExecutionProvider({
    run: async (input) => {
      decision = await input.decidePermission?.({ sessionId: 'session-42', permissionId: 'per_1', type: 'external_directory', title: 'external_directory', patterns: ['/repo/.worktree/feature/*'] }) ?? '';
      return { sessionId: 'session-42', output: ['ok'] };
    },
  });

  await provider.execute({
    plan: { repoRoot: '/repo', model: { id: 'openai/gpt-5.4-mini' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
  });

  assert.equal(decision, 'always');
});

test('external directory auto-reject does not enter manual coordinator history', async () => {
  const coordinator = new PermissionCoordinator({
    promptAdapter: async () => 'once',
  });

  const decision = await decideAfkPermission(
    { sessionId: 'session-42', permissionId: 'per_1', type: 'external_directory', title: 'external_directory', patterns: ['/tmp/worktree/*'] },
    { ticketLabel: 'feat/01', coordinator, repoRoot: '/repo' },
  );

  assert.equal(decision, 'reject');
  assert.equal(coordinator.history.length, 0);
});

test('external directory inside repo root bypasses manual coordinator', async () => {
  const coordinator = new PermissionCoordinator({
    promptAdapter: async () => 'once',
  });

  const decision = await decideAfkPermission(
    { sessionId: 'session-42', permissionId: 'per_1', type: 'external_directory', title: 'external_directory', patterns: ['/repo/.git/*', '/repo/.worktree/feature/*'] },
    { ticketLabel: 'feat/01', coordinator, repoRoot: '/repo' },
  );

  assert.equal(decision, 'always');
  assert.equal(coordinator.history.length, 0);
});

test('AFK permission policy leaves non-external requests to OpenCode defaults', async () => {
  assert.equal(await decideAfkPermission({ sessionId: 'session-42', permissionId: 'per_2', type: 'bash', title: 'bash', patterns: ['bun test'] }), null);
});

test('shared permission coordinator serializes concurrent tickets FIFO', async () => {
  const promptOrder: string[] = [];
  const activeByPrompt: number[] = [];
  let activePrompts = 0;
  const releaseByPermission = new Map<string, () => void>();
  const coordinator = new PermissionCoordinator({
    promptAdapter: async ({ request, metadata }) => {
      activePrompts += 1;
      activeByPrompt.push(activePrompts);
      promptOrder.push(`${metadata.ticketLabel}:${request.permissionId}`);
      await new Promise<void>((resolve) => {
        releaseByPermission.set(request.permissionId, resolve);
      });
      activePrompts -= 1;
      return 'once';
    },
  });

  const provider = new OpenCodeAgentExecutionProvider({
    run: async (input) => {
      const sessionId = input.title.includes('feat-a/001') ? 'session-a' : 'session-b';
      const permissionId = sessionId === 'session-a' ? 'per-a' : 'per-b';
      const decisionTask = input.decidePermission?.({
        sessionId,
        permissionId,
        type: 'bash',
        title: `bash-${permissionId}`,
        patterns: ['bun test'],
      });
      await waitFor(() => releaseByPermission.has(permissionId));
      releaseByPermission.get(permissionId)?.();
      await decisionTask;
      return { sessionId, output: ['ok'] };
    },
  }, coordinator);

  const first = provider.execute({
    plan: { model: { id: 'openai/gpt-5.4-mini' }, tickets: [{ label: 'feat-a/001' }] } as never,
    ticketIndex: 0,
    prompt: 'run-a',
  });
  const second = provider.execute({
    plan: { model: { id: 'openai/gpt-5.4-mini' }, tickets: [{ label: 'feat-b/001' }] } as never,
    ticketIndex: 0,
    prompt: 'run-b',
  });

  await Promise.all([first, second]);

  assert.deepEqual(promptOrder, ['feat-a/001:per-a', 'feat-b/001:per-b']);
  assert.deepEqual(activeByPrompt, [1, 1]);
  assert.deepEqual(coordinator.history.map((entry) => `${entry.metadata.ticketLabel}:${entry.request.permissionId}`), [
    'feat-a/001:per-a',
    'feat-b/001:per-b',
  ]);
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('condition not met before timeout');
}
