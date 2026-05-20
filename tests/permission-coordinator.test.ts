import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PermissionCoordinator,
  PermissionPromptCancelledError,
  PermissionPromptNonInteractiveError,
  formatPermissionPromptMessage,
} from '../src/permission-coordinator.js';
import type { OpenCodePermissionRequest } from '../src/opencode.js';

function request(overrides: Partial<OpenCodePermissionRequest> = {}): OpenCodePermissionRequest {
  return {
    sessionId: 'session-1',
    permissionId: 'perm-1',
    type: 'external_directory',
    title: 'Access external directory',
    patterns: ['/repo/*'],
    ...overrides,
  };
}

test('serializes concurrent submit calls and preserves FIFO order', async () => {
  const callOrder: string[] = [];
  let activePrompts = 0;
  let maxActivePrompts = 0;
  const release: Array<() => void> = [];
  const coordinator = new PermissionCoordinator({
    ticketLabel: 'manual-permission-queue/01',
    promptAdapter: async ({ request: input }) => {
      activePrompts += 1;
      maxActivePrompts = Math.max(maxActivePrompts, activePrompts);
      callOrder.push(input.permissionId);
      await new Promise<void>((resolve) => release.push(resolve));
      activePrompts -= 1;
      return 'once';
    },
  });

  const first = coordinator.submit(request({ permissionId: 'perm-1' }));
  const second = coordinator.submit(request({ permissionId: 'perm-2' }));
  const third = coordinator.submit(request({ permissionId: 'perm-3' }));

  await waitFor(() => callOrder.length === 1);
  assert.equal(coordinator.promptActive, true);
  assert.deepEqual(callOrder, ['perm-1']);
  assert.equal(maxActivePrompts, 1);

  release.shift()?.();
  await waitFor(() => callOrder.length === 2);
  assert.deepEqual(callOrder, ['perm-1', 'perm-2']);

  release.shift()?.();
  await waitFor(() => callOrder.length === 3);
  assert.deepEqual(callOrder, ['perm-1', 'perm-2', 'perm-3']);

  release.shift()?.();
  assert.deepEqual(await Promise.all([first, second, third]), ['once', 'once', 'once']);
  assert.equal(maxActivePrompts, 1);
  assert.equal(coordinator.promptActive, false);
});

test('captures queued count and metadata at prompt render time', async () => {
  const metadata: Array<{ permissionId: string; queuedCount: number; message: string; sessionId: string }> = [];
  let releaseFirst: (() => void) | undefined;
  const coordinator = new PermissionCoordinator({
    ticketLabel: 'manual-permission-queue/01',
    promptAdapter: async ({ request: input, metadata: info, message }) => {
      metadata.push({ permissionId: input.permissionId, queuedCount: info.queuedCount, message, sessionId: info.sessionId });
      if (input.permissionId === 'perm-1') {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return 'always';
    },
  });

  const first = coordinator.submit(request({ permissionId: 'perm-1', sessionId: '' }));
  const second = coordinator.submit(request({ permissionId: 'perm-2', patterns: [] }));
  const third = coordinator.submit(request({ permissionId: 'perm-3' }));

  await Promise.resolve();
  releaseFirst?.();
  await Promise.all([first, second, third]);

  assert.deepEqual(metadata.map((entry) => [entry.permissionId, entry.queuedCount]), [
    ['perm-1', 2],
    ['perm-2', 1],
    ['perm-3', 0],
  ]);
  assert.equal(metadata[0]?.sessionId, 'unknown');
  assert.match(metadata[0]?.message ?? '', /Ticket: manual-permission-queue\/01/);
  assert.match(metadata[0]?.message ?? '', /Permission ID: perm-1/);
  assert.match(metadata[0]?.message ?? '', /Queued: 2/);
});

test('returns reject and records cancellation reason', async () => {
  const coordinator = new PermissionCoordinator({
    ticketLabel: 'manual-permission-queue/01',
    promptAdapter: async () => {
      throw new PermissionPromptCancelledError();
    },
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });

  const decision = await coordinator.submit(request({ permissionId: 'cancelled' }));
  assert.equal(decision, 'reject');
  assert.equal(coordinator.history.length, 1);
  assert.equal(coordinator.history[0]?.safeDefaultReason, 'prompt-cancelled');
  assert.equal(coordinator.history[0]?.recordedAt, '2026-01-01T00:00:00.000Z');
});

test('returns reject and records non-interactive reason', async () => {
  const coordinator = new PermissionCoordinator({
    ticketLabel: 'manual-permission-queue/01',
    promptAdapter: async () => {
      throw new PermissionPromptNonInteractiveError();
    },
  });

  const decision = await coordinator.submit(request({ permissionId: 'notty' }));
  assert.equal(decision, 'reject');
  assert.equal(coordinator.history[0]?.safeDefaultReason, 'non-interactive-tty');
});

test('records history details and summary output', async () => {
  const coordinator = new PermissionCoordinator({
    ticketLabel: 'manual-permission-queue/01',
    promptAdapter: async ({ request: input }) => (input.permissionId === 'a' ? 'once' : null),
  });

  await coordinator.submit(request({ permissionId: 'a', patterns: ['tmp/*'] }));
  await coordinator.submit(request({ permissionId: 'b', type: 'bash', title: 'run command', patterns: [] }));

  assert.equal(coordinator.history.length, 2);
  assert.equal(coordinator.history[0]?.order, 1);
  assert.equal(coordinator.history[1]?.order, 2);
  assert.equal(coordinator.history[1]?.decision, 'reject');
  assert.equal(coordinator.history[1]?.safeDefaultReason, 'invalid-decision');
  assert.match(coordinator.formatHistorySummary(), /#1 once external_directory \[tmp\/\*\]/);
  assert.match(coordinator.formatHistorySummary(), /#2 reject \(invalid-decision\) bash/);
});

test('formats prompt message including optional patterns', () => {
  const withPatterns = formatPermissionPromptMessage({
    ticketLabel: 'feature/01',
    sessionId: 'session-55',
    permissionId: 'perm-x',
    type: 'external_directory',
    title: 'External access',
    patterns: ['/tmp/*', '/var/*'],
    queuedCount: 3,
  });
  assert.match(withPatterns, /Patterns: \/tmp\/\*, \/var\/\*/);

  const withoutPatterns = formatPermissionPromptMessage({
    ticketLabel: 'feature/01',
    sessionId: 'session-55',
    permissionId: 'perm-x',
    type: 'external_directory',
    title: 'External access',
    patterns: [],
    queuedCount: 0,
  });
  assert.doesNotMatch(withoutPatterns, /Patterns:/);
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('condition not met before timeout');
}
