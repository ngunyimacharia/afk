import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyProgressEvent, classifyRunOutcome, NotificationPolicy } from '../src/notification-policy.js';
import type { AgentExecutionProgressEvent } from '../src/types.js';

test('permission-required event produces a notification payload', () => {
  const policy = new NotificationPolicy();
  const event = {
    kind: 'permission-required' as const,
    ticketLabel: 'feat-a/001',
    permissionKey: 'feat-a/001:per_1',
    message: 'bash tool requested',
  };
  const payload = policy.maybeNotify(event);

  assert.ok(payload);
  assert.equal(payload.category, 'permission-required');
  assert.match(payload.title, /feat-a\/001/);
  assert.match(payload.message, /bash tool requested/);
});

test('duplicate permission-required event is deduplicated', () => {
  const policy = new NotificationPolicy();
  const event = {
    kind: 'permission-required' as const,
    ticketLabel: 'feat-a/001',
    permissionKey: 'feat-a/001:per_1',
    message: 'bash tool requested',
  };

  const first = policy.maybeNotify(event);
  const second = policy.maybeNotify(event);

  assert.ok(first);
  assert.equal(second, null);
});

test('different permission keys for the same ticket each notify once', () => {
  const policy = new NotificationPolicy();
  const e1 = {
    kind: 'permission-required' as const,
    ticketLabel: 'feat-a/001',
    permissionKey: 'feat-a/001:per_1',
    message: 'bash tool requested',
  };
  const e2 = {
    kind: 'permission-required' as const,
    ticketLabel: 'feat-a/001',
    permissionKey: 'feat-a/001:per_2',
    message: 'external_directory tool requested',
  };

  const first = policy.maybeNotify(e1);
  const second = policy.maybeNotify(e2);

  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.message, second.message);
});

test('ticket-blocked event produces a notification payload', () => {
  const policy = new NotificationPolicy();
  const event = {
    kind: 'ticket-blocked' as const,
    ticketLabel: 'feat-a/001',
    message: 'needs-human handoff required',
  };
  const payload = policy.maybeNotify(event);

  assert.ok(payload);
  assert.equal(payload.category, 'ticket-blocked');
  assert.match(payload.title, /feat-a\/001/);
  assert.match(payload.message, /needs-human handoff required/);
});

test('duplicate ticket-blocked event is deduplicated', () => {
  const policy = new NotificationPolicy();
  const event = {
    kind: 'ticket-blocked' as const,
    ticketLabel: 'feat-a/001',
    message: 'needs-human handoff required',
  };

  const first = policy.maybeNotify(event);
  const second = policy.maybeNotify(event);

  assert.ok(first);
  assert.equal(second, null);
});

test('ticket-failed event produces a notification payload', () => {
  const policy = new NotificationPolicy();
  const event = {
    kind: 'ticket-failed' as const,
    ticketLabel: 'feat-b/002',
    message: 'provider execution failed',
  };
  const payload = policy.maybeNotify(event);

  assert.ok(payload);
  assert.equal(payload.category, 'ticket-failed');
  assert.match(payload.title, /feat-b\/002/);
  assert.match(payload.message, /provider execution failed/);
});

test('duplicate ticket-failed event is deduplicated', () => {
  const policy = new NotificationPolicy();
  const event = {
    kind: 'ticket-failed' as const,
    ticketLabel: 'feat-b/002',
    message: 'provider execution failed',
  };

  const first = policy.maybeNotify(event);
  const second = policy.maybeNotify(event);

  assert.ok(first);
  assert.equal(second, null);
});

test('blocked and failed for the same ticket are independent', () => {
  const policy = new NotificationPolicy();
  const blocked = {
    kind: 'ticket-blocked' as const,
    ticketLabel: 'feat-a/001',
    message: 'blocked first',
  };
  const failed = {
    kind: 'ticket-failed' as const,
    ticketLabel: 'feat-a/001',
    message: 'failed later',
  };

  const p1 = policy.maybeNotify(blocked);
  const p2 = policy.maybeNotify(failed);

  assert.ok(p1);
  assert.ok(p2);
  assert.equal(p1.category, 'ticket-blocked');
  assert.equal(p2.category, 'ticket-failed');
});

test('run-completed-success produces exactly one notification', () => {
  const policy = new NotificationPolicy();
  const event = {
    kind: 'run-completed-success' as const,
    runId: 'run-1',
    ticketCount: 3,
  };

  const first = policy.maybeNotify(event);
  const second = policy.maybeNotify(event);

  assert.ok(first);
  assert.equal(first.category, 'run-completed-success');
  assert.match(first.title, /Run completed/);
  assert.match(first.message, /3 ticket/);
  assert.equal(second, null);
});

test('run-completed-with-issues produces exactly one notification', () => {
  const policy = new NotificationPolicy();
  const event = {
    kind: 'run-completed-with-issues' as const,
    runId: 'run-1',
    ticketCount: 5,
    failedCount: 2,
    blockedCount: 1,
  };

  const first = policy.maybeNotify(event);
  const second = policy.maybeNotify(event);

  assert.ok(first);
  assert.equal(first.category, 'run-completed-with-issues');
  assert.match(first.title, /Run completed with issues/);
  assert.match(first.message, /2 failed, 1 blocked out of 5 ticket/);
  assert.equal(second, null);
});

test('success and issues run outcomes are mutually exclusive', () => {
  const policy = new NotificationPolicy();
  const success = {
    kind: 'run-completed-success' as const,
    runId: 'run-1',
    ticketCount: 3,
  };
  const issues = {
    kind: 'run-completed-with-issues' as const,
    runId: 'run-1',
    ticketCount: 3,
    failedCount: 1,
    blockedCount: 0,
  };

  const first = policy.maybeNotify(success);
  const second = policy.maybeNotify(issues);

  assert.ok(first);
  assert.equal(first.category, 'run-completed-success');
  assert.equal(second, null);
});

test('reset clears all deduplication state', () => {
  const policy = new NotificationPolicy();
  const permission = {
    kind: 'permission-required' as const,
    ticketLabel: 'feat-a/001',
    permissionKey: 'feat-a/001:per_1',
    message: 'bash tool requested',
  };
  const blocked = {
    kind: 'ticket-blocked' as const,
    ticketLabel: 'feat-a/001',
    message: 'handoff',
  };
  const run = {
    kind: 'run-completed-success' as const,
    ticketCount: 1,
  };

  assert.ok(policy.maybeNotify(permission));
  assert.ok(policy.maybeNotify(blocked));
  assert.ok(policy.maybeNotify(run));

  policy.reset();

  assert.ok(policy.maybeNotify(permission));
  assert.ok(policy.maybeNotify(blocked));
  assert.ok(policy.maybeNotify(run));
});

test('classifyProgressEvent returns permission event for kind=permission', () => {
  const event: AgentExecutionProgressEvent = {
    ticketLabel: 'feat/001',
    message: 'opencode permission required: bash; requested allow',
    kind: 'permission',
    sessionId: 's1',
    permissionId: 'per_1',
  };
  const classified = classifyProgressEvent(event);

  assert.ok(classified);
  assert.equal(classified.kind, 'permission-required');
  assert.equal(classified.ticketLabel, 'feat/001');
  assert.equal(classified.permissionKey, 'feat/001:per_1');
});

test('classifyProgressEvent returns failed event for kind=failure', () => {
  const event: AgentExecutionProgressEvent = {
    ticketLabel: 'feat/001',
    message: 'provider failure: model unavailable',
    kind: 'failure',
    sessionId: 's1',
  };
  const classified = classifyProgressEvent(event);

  assert.ok(classified);
  assert.equal(classified.kind, 'ticket-failed');
  assert.equal(classified.ticketLabel, 'feat/001');
});

test('classifyProgressEvent returns null for normal progress messages', () => {
  const event: AgentExecutionProgressEvent = {
    ticketLabel: 'feat/001',
    message: 'starting ticket run',
    sessionId: 's1',
  };
  const classified = classifyProgressEvent(event);

  assert.equal(classified, null);
});

test('classifyProgressEvent returns null for routine assistant deltas', () => {
  const event: AgentExecutionProgressEvent = {
    ticketLabel: 'feat/001',
    message: 'opencode session busy',
    sessionId: 's1',
  };
  const classified = classifyProgressEvent(event);

  assert.equal(classified, null);
});

test('classifyRunOutcome returns success when all tickets complete', () => {
  const event = classifyRunOutcome({
    runId: 'run-1',
    ticketResults: [
      { ticketLabel: 'feat-a/001', outcome: 'completed' },
      { ticketLabel: 'feat-a/002', outcome: 'completed' },
    ],
  });

  assert.ok(event);
  assert.equal(event.kind, 'run-completed-success');
  assert.equal(event.ticketCount, 2);
});

test('classifyRunOutcome returns issues when any ticket fails or blocks', () => {
  const event = classifyRunOutcome({
    runId: 'run-1',
    ticketResults: [
      { ticketLabel: 'feat-a/001', outcome: 'completed' },
      { ticketLabel: 'feat-a/002', outcome: 'failed' },
      { ticketLabel: 'feat-a/003', outcome: 'blocked' },
      { ticketLabel: 'feat-a/004', outcome: 'not-scheduled' },
    ],
  });

  assert.ok(event);
  assert.equal(event.kind, 'run-completed-with-issues');
  assert.equal(event.ticketCount, 4);
  assert.equal(event.failedCount, 1);
  assert.equal(event.blockedCount, 2);
});

test('classifyRunOutcome returns null for empty results', () => {
  const event = classifyRunOutcome({ runId: 'run-1', ticketResults: [] });
  assert.equal(event, null);
});

test('permission without explicit permissionKey falls back to message-based key', () => {
  const policy = new NotificationPolicy();
  const event = {
    kind: 'permission-required' as const,
    ticketLabel: 'feat-a/001',
    message: 'bash tool requested',
  };

  const first = policy.maybeNotify(event);
  const second = policy.maybeNotify(event);

  assert.ok(first);
  assert.equal(second, null);
});

test('notification payloads include default messages when message is omitted', () => {
  const policy = new NotificationPolicy();

  const permission = policy.maybeNotify({
    kind: 'permission-required',
    ticketLabel: 'feat/001',
  });
  assert.ok(permission);
  assert.match(permission.message, /permission request needs your attention/);

  const blocked = policy.maybeNotify({
    kind: 'ticket-blocked',
    ticketLabel: 'feat/001',
  });
  assert.ok(blocked);
  assert.match(blocked.message, /blocked and needs human handoff/);

  const failed = policy.maybeNotify({
    kind: 'ticket-failed',
    ticketLabel: 'feat/001',
  });
  assert.ok(failed);
  assert.match(failed.message, /failed during execution/);
});
