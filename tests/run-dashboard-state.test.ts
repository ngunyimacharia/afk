import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunDashboardState } from '../src/run-dashboard-state.js';
import type { TicketRecord } from '../src/types.js';

function makeTickets(): TicketRecord[] {
  return [
    {
      path: '/tmp/a-1.md',
      feature: 'feat-a',
      issueName: '001',
      label: 'feat-a/001',
      executorAfk: true,
    },
    {
      path: '/tmp/a-2.md',
      feature: 'feat-a',
      issueName: '002',
      label: 'feat-a/002',
      executorAfk: true,
    },
    {
      path: '/tmp/b-1.md',
      feature: 'feat-b',
      issueName: '001',
      label: 'feat-b/001',
      executorAfk: true,
    },
  ];
}

test('tickets start in ready state and pre-completed tickets start as complete', () => {
  const tickets: TicketRecord[] = [
    ...makeTickets(),
    {
      path: '/tmp/c-1.md',
      feature: 'feat-c',
      issueName: '001',
      label: 'feat-c/001',
      status: 'done',
      executorAfk: true,
    },
  ];
  const state = new RunDashboardState({}, tickets);
  const snap = state.snapshot();

  assert.equal(snap.tickets.find((t) => t.label === 'feat-a/001')?.runtimeState, 'ready');
  assert.equal(snap.tickets.find((t) => t.label === 'feat-c/001')?.runtimeState, 'complete');
  assert.equal(snap.aggregate.ready, 3);
  assert.equal(snap.aggregate.complete, 1);
  assert.equal(snap.aggregate.total, 4);
});

test('normal progress events move ticket to running then complete', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.ingest({ ticketLabel: 'feat-a/001', message: 'starting ticket run' });
  let snap = state.snapshot();
  assert.equal(snap.tickets.find((t) => t.label === 'feat-a/001')?.runtimeState, 'running');
  assert.equal(snap.aggregate.running, 1);

  state.ingest({
    ticketLabel: 'feat-a/001',
    message: 'tool bash running: bun test',
    sessionId: 'session-1',
  });
  snap = state.snapshot();
  assert.equal(snap.tickets.find((t) => t.label === 'feat-a/001')?.latestMessage, 'tool bash running: bun test');
  assert.equal(snap.tickets.find((t) => t.label === 'feat-a/001')?.sessionId, 'session-1');

  state.ingest({
    ticketLabel: 'feat-a/001',
    message: 'run completed',
    sessionId: 'session-1',
  });
  snap = state.snapshot();
  assert.equal(snap.tickets.find((t) => t.label === 'feat-a/001')?.runtimeState, 'complete');
  assert.equal(snap.aggregate.complete, 1);
  assert.equal(snap.aggregate.running, 0);
});

test('permission events create action-needed without losing running state', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.ingest({ ticketLabel: 'feat-a/001', message: 'starting ticket run' });
  state.ingest({
    ticketLabel: 'feat-a/001',
    kind: 'permission',
    message: 'opencode permission required: external_directory',
    permissionId: 'per_1',
    sessionId: 'session-1',
  });

  const snap = state.snapshot();
  const ticket = snap.tickets.find((t) => t.label === 'feat-a/001');
  assert.ok(ticket);
  assert.equal(ticket.runtimeState, 'running');
  assert.equal(ticket.hasPermission, true);
  assert.equal(ticket.actionNeededCount, 1);

  assert.equal(snap.actionNeeded.length, 1);
  assert.equal(snap.actionNeeded[0]?.kind, 'permission');
  assert.equal(snap.actionNeeded[0]?.ticketLabel, 'feat-a/001');
  assert.match(snap.actionNeeded[0]?.message, /external_directory/);
});

test('duplicate permission events are deduplicated', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.ingest({
    ticketLabel: 'feat-a/001',
    kind: 'permission',
    message: 'opencode permission required: bash',
    permissionId: 'per_1',
  });
  state.ingest({
    ticketLabel: 'feat-a/001',
    kind: 'permission',
    message: 'opencode permission required: bash',
    permissionId: 'per_1',
  });

  const snap = state.snapshot();
  assert.equal(snap.actionNeeded.length, 1);
});

test('failure events create action-needed without losing running state', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.ingest({ ticketLabel: 'feat-b/001', message: 'starting ticket run' });
  state.ingest({
    ticketLabel: 'feat-b/001',
    kind: 'failure',
    message: 'provider failure: selected model is unavailable',
    sessionId: 'session-2',
  });

  const snap = state.snapshot();
  const ticket = snap.tickets.find((t) => t.label === 'feat-b/001');
  assert.ok(ticket);
  assert.equal(ticket.runtimeState, 'running');
  assert.equal(ticket.hasFailure, true);
  assert.equal(ticket.actionNeededCount, 1);

  assert.equal(snap.actionNeeded.length, 1);
  assert.equal(snap.actionNeeded[0]?.kind, 'failure');
  assert.equal(snap.actionNeeded[0]?.ticketLabel, 'feat-b/001');
});

test('blocked outcome from message creates action-needed and sets blocked state', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.ingest({ ticketLabel: 'feat-a/001', message: 'run blocked' });

  const snap = state.snapshot();
  const ticket = snap.tickets.find((t) => t.label === 'feat-a/001');
  assert.ok(ticket);
  assert.equal(ticket.runtimeState, 'blocked');
  assert.equal(ticket.actionNeededCount, 1);
  assert.equal(snap.actionNeeded[0]?.kind, 'blocked');
  assert.equal(snap.aggregate.blocked, 1);
});

test('handoff messages infer blocked state', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.ingest({
    ticketLabel: 'feat-a/001',
    message: 'malformed reviewer output handoff',
  });
  assert.equal(state.snapshot().tickets.find((t) => t.label === 'feat-a/001')?.runtimeState, 'blocked');

  state.ingest({
    ticketLabel: 'feat-a/002',
    message: 'budget handoff: ticket-wall-clock-ms exceeded',
  });
  assert.equal(state.snapshot().tickets.find((t) => t.label === 'feat-a/002')?.runtimeState, 'blocked');

  state.ingest({
    ticketLabel: 'feat-b/001',
    message: 'launcher context mismatch',
  });
  assert.equal(state.snapshot().tickets.find((t) => t.label === 'feat-b/001')?.runtimeState, 'blocked');
});

test('failed messages infer failed state', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.ingest({
    ticketLabel: 'feat-a/001',
    message: 'run failed: provider error',
  });
  assert.equal(state.snapshot().tickets.find((t) => t.label === 'feat-a/001')?.runtimeState, 'failed');

  state.ingest({ ticketLabel: 'feat-a/002', message: 'run interrupted' });
  assert.equal(state.snapshot().tickets.find((t) => t.label === 'feat-a/002')?.runtimeState, 'failed');
});

test('setTicketOutcome updates runtime state and creates blocked action for blocked outcomes', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.setTicketOutcome('feat-a/001', 'completed');
  state.setTicketOutcome('feat-a/002', 'failed');
  state.setTicketOutcome('feat-b/001', 'blocked');

  const snap = state.snapshot();
  assert.equal(snap.tickets.find((t) => t.label === 'feat-a/001')?.runtimeState, 'complete');
  assert.equal(snap.tickets.find((t) => t.label === 'feat-a/002')?.runtimeState, 'failed');
  assert.equal(snap.tickets.find((t) => t.label === 'feat-b/001')?.runtimeState, 'blocked');
  assert.equal(snap.aggregate.complete, 1);
  assert.equal(snap.aggregate.failed, 1);
  assert.equal(snap.aggregate.blocked, 1);

  const blockedAction = snap.actionNeeded.find((a) => a.ticketLabel === 'feat-b/001');
  assert.ok(blockedAction);
  assert.equal(blockedAction.kind, 'blocked');
});

test('not-scheduled outcome maps to blocked state', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.setTicketOutcome('feat-a/001', 'not-scheduled');
  assert.equal(state.snapshot().tickets.find((t) => t.label === 'feat-a/001')?.runtimeState, 'blocked');
});

test('multiple features have correct aggregate states', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.ingest({ ticketLabel: 'feat-a/001', message: 'starting ticket run' });
  state.setTicketOutcome('feat-b/001', 'completed');

  const snap = state.snapshot();
  const featA = snap.features.find((f) => f.feature === 'feat-a');
  const featB = snap.features.find((f) => f.feature === 'feat-b');
  assert.ok(featA);
  assert.ok(featB);
  assert.equal(featA.aggregateState, 'running');
  assert.equal(featB.aggregateState, 'complete');
});

test('feature aggregate prefers running over blocked over failed over complete', () => {
  const state = new RunDashboardState({}, makeTickets());
  // feat-a: one running, one blocked
  state.ingest({ ticketLabel: 'feat-a/001', message: 'starting ticket run' });
  state.ingest({ ticketLabel: 'feat-a/002', message: 'run blocked' });
  assert.equal(state.snapshot().features.find((f) => f.feature === 'feat-a')?.aggregateState, 'running');

  // feat-b: one failed, one complete
  const state2 = new RunDashboardState({}, makeTickets());
  state2.setTicketOutcome('feat-b/001', 'failed');
  state2.setTicketOutcome('feat-b/001', 'completed'); // only one ticket in feat-b here
  // reset to fresh state with two tickets in feat-b
  const tickets: TicketRecord[] = [
    {
      path: '/tmp/b-1.md',
      feature: 'feat-b',
      issueName: '001',
      label: 'feat-b/001',
      executorAfk: true,
    },
    {
      path: '/tmp/b-2.md',
      feature: 'feat-b',
      issueName: '002',
      label: 'feat-b/002',
      executorAfk: true,
    },
  ];
  const state3 = new RunDashboardState({}, tickets);
  state3.setTicketOutcome('feat-b/001', 'failed');
  state3.setTicketOutcome('feat-b/002', 'completed');
  assert.equal(state3.snapshot().features.find((f) => f.feature === 'feat-b')?.aggregateState, 'failed');
});

test('events for unknown tickets are ignored', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.ingest({ ticketLabel: 'unknown/999', message: 'starting ticket run' });
  const snap = state.snapshot();
  assert.equal(snap.tickets.length, 3);
  assert.equal(snap.aggregate.ready, 3);
  assert.equal(snap.recentEvents.length, 0);
});

test('snapshot is deterministic and read-only', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.ingest({ ticketLabel: 'feat-a/001', message: 'starting ticket run' });

  const snap1 = state.snapshot();
  const snap2 = state.snapshot();
  assert.deepEqual(snap1, snap2);

  // Mutating returned arrays should not affect internal state
  snap1.recentEvents.push({ ticketLabel: 'feat-a/001', message: 'extra' });
  snap1.actionNeeded.push({
    kind: 'permission',
    ticketLabel: 'x',
    message: 'x',
    timestamp: 0,
  });
  const snap3 = state.snapshot();
  assert.equal(snap3.recentEvents.length, 1);
  assert.equal(snap3.actionNeeded.length, 0);
});

test('recent events are capped', () => {
  const state = new RunDashboardState({}, makeTickets());
  for (let i = 0; i < 60; i++) {
    state.ingest({ ticketLabel: 'feat-a/001', message: `event ${i}` });
  }
  const snap = state.snapshot();
  assert.equal(snap.recentEvents.length, 50);
  assert.equal(snap.recentEvents[0]?.message, 'event 10');
  assert.equal(snap.recentEvents[49]?.message, 'event 59');
});

test('run metadata is reflected in snapshot', () => {
  const state = new RunDashboardState(
    {
      runId: 'run-123',
      modelId: 'model-x',
      harness: 'opencode',
      concurrency: 3,
    },
    makeTickets(),
  );
  const snap = state.snapshot();
  assert.equal(snap.runId, 'run-123');
  assert.equal(snap.modelId, 'model-x');
  assert.equal(snap.harness, 'opencode');
  assert.equal(snap.concurrency, 3);
  assert.equal(snap.elapsedMs >= 0, true);
});

test('elapsed time uses injected now function', () => {
  let tick = 1000;
  const state = new RunDashboardState({ startTime: 500, now: () => tick }, makeTickets());
  assert.equal(state.snapshot().elapsedMs, 500);
  tick = 1500;
  assert.equal(state.snapshot().elapsedMs, 1000);
});

test('terminal state is preserved through subsequent non-terminal events', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.ingest({ ticketLabel: 'feat-a/001', message: 'run completed' });
  state.ingest({ ticketLabel: 'feat-a/001', message: 'some stray update' });

  const snap = state.snapshot();
  assert.equal(snap.tickets.find((t) => t.label === 'feat-a/001')?.runtimeState, 'complete');
});

test('permission and failure action-needed items accumulate for the same ticket', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.ingest({
    ticketLabel: 'feat-a/001',
    kind: 'permission',
    message: 'permission A',
  });
  state.ingest({
    ticketLabel: 'feat-a/001',
    kind: 'failure',
    message: 'failure A',
  });
  state.ingest({
    ticketLabel: 'feat-a/001',
    kind: 'permission',
    message: 'permission B',
  });

  const snap = state.snapshot();
  assert.equal(snap.actionNeeded.length, 3);
  assert.equal(snap.tickets.find((t) => t.label === 'feat-a/001')?.actionNeededCount, 3);
});
