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

test('progress events create placeholder tickets when attaching without launch plan', () => {
  const state = new RunDashboardState({ runId: 'run-1' });

  state.ingest({ ticketLabel: 'feat-a/001', message: 'starting ticket run' });

  const snap = state.snapshot();
  assert.equal(snap.tickets.length, 1);
  assert.equal(snap.tickets[0]?.label, 'feat-a/001');
  assert.equal(snap.tickets[0]?.feature, 'feat-a');
  assert.equal(snap.tickets[0]?.issueName, '001');
  assert.equal(snap.tickets[0]?.runtimeState, 'running');
  assert.equal(snap.selectedTicket?.label, 'feat-a/001');
  assert.equal(snap.aggregate.running, 1);
});

test('run-level replay events do not create placeholder tickets', () => {
  const state = new RunDashboardState({ runId: 'run-1' });

  state.ingest({ ticketLabel: '__run__', message: 'Recovered stale run run-1' });

  const snap = state.snapshot();
  assert.equal(snap.tickets.length, 0);
  assert.equal(snap.recentEvents.length, 0);
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

test('handoff and launcher context mismatch messages do not infer blocked', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.ingest({
    ticketLabel: 'feat-a/001',
    message: 'malformed reviewer output handoff',
  });
  assert.equal(state.snapshot().tickets.find((t) => t.label === 'feat-a/001')?.runtimeState, 'running');

  state.ingest({
    ticketLabel: 'feat-a/002',
    message: 'budget handoff: ticket-wall-clock-ms exceeded',
  });
  assert.equal(state.snapshot().tickets.find((t) => t.label === 'feat-a/002')?.runtimeState, 'running');

  state.ingest({
    ticketLabel: 'feat-b/001',
    message: 'launcher context mismatch',
  });
  assert.equal(state.snapshot().tickets.find((t) => t.label === 'feat-b/001')?.runtimeState, 'running');
});

test('failed messages infer failed state and create action-needed', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.ingest({
    ticketLabel: 'feat-a/001',
    message: 'run failed: provider error',
  });
  let snap = state.snapshot();
  assert.equal(snap.tickets.find((t) => t.label === 'feat-a/001')?.runtimeState, 'failed');
  assert.equal(snap.tickets.find((t) => t.label === 'feat-a/001')?.actionNeededCount, 1);
  assert.equal(snap.actionNeeded.length, 1);
  assert.equal(snap.actionNeeded[0]?.kind, 'failure');
  assert.equal(snap.actionNeeded[0]?.ticketLabel, 'feat-a/001');

  state.ingest({ ticketLabel: 'feat-a/002', message: 'run interrupted' });
  snap = state.snapshot();
  assert.equal(snap.tickets.find((t) => t.label === 'feat-a/002')?.runtimeState, 'failed');
  assert.equal(snap.tickets.find((t) => t.label === 'feat-a/002')?.actionNeededCount, 1);
  assert.equal(snap.actionNeeded.length, 2);
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

test('not-scheduled outcome maps to skipped state', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.setTicketOutcome('feat-a/001', 'not-scheduled');
  const snap = state.snapshot();
  assert.equal(snap.tickets.find((t) => t.label === 'feat-a/001')?.runtimeState, 'skipped');
  assert.equal(snap.aggregate.skipped, 1);
});

test('skipped state is terminal and does not flip back to running', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.setTicketOutcome('feat-a/001', 'not-scheduled');
  state.ingest({ ticketLabel: 'feat-a/001', message: 'some stray update' });

  const snap = state.snapshot();
  assert.equal(snap.tickets.find((t) => t.label === 'feat-a/001')?.runtimeState, 'skipped');
  assert.equal(snap.aggregate.skipped, 1);
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
  const state = new RunDashboardState({ now: () => 1_000, startTime: 0 }, makeTickets());
  state.ingest({ ticketLabel: 'feat-a/001', message: 'starting ticket run' });
  state.ingest({
    ticketLabel: 'feat-a/001',
    kind: 'permission',
    message: 'permission message',
    permissionId: 'per_1',
  });

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

  // Mutating nested objects should not affect internal state
  snap1.recentEvents[0].message = 'mutated event';
  snap1.actionNeeded[0].message = 'mutated action';

  const snap3 = state.snapshot();
  assert.equal(snap3.recentEvents.length, 2);
  assert.equal(snap3.recentEvents[0]?.message, 'starting ticket run');
  assert.equal(snap3.actionNeeded.length, 1);
  assert.equal(snap3.actionNeeded[0]?.message, 'permission message');
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

test('elapsed time stops when run is completed', () => {
  let tick = 1000;
  const state = new RunDashboardState({ startTime: 500, now: () => tick }, makeTickets());
  state.completeRun();
  assert.equal(state.snapshot().elapsedMs, 500);
  tick = 5000;
  assert.equal(state.snapshot().elapsedMs, 500);
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

test('selection defaults to first ticket', () => {
  const state = new RunDashboardState({}, makeTickets());
  const snap = state.snapshot();
  assert.equal(snap.selectedTicket?.label, 'feat-a/001');
  assert.ok(snap.selectedTicketDetails);
  assert.equal(snap.selectedTicketDetails?.label, 'feat-a/001');
});

test('selectNextTicket moves forward and wraps around', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.selectNextTicket();
  assert.equal(state.snapshot().selectedTicket?.label, 'feat-a/002');
  state.selectNextTicket();
  assert.equal(state.snapshot().selectedTicket?.label, 'feat-b/001');
  state.selectNextTicket();
  assert.equal(state.snapshot().selectedTicket?.label, 'feat-a/001');
});

test('selectPreviousTicket moves backward and wraps around', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.selectPreviousTicket();
  assert.equal(state.snapshot().selectedTicket?.label, 'feat-b/001');
  state.selectPreviousTicket();
  assert.equal(state.snapshot().selectedTicket?.label, 'feat-a/002');
  state.selectPreviousTicket();
  assert.equal(state.snapshot().selectedTicket?.label, 'feat-a/001');
});

test('selectNextActionNeeded jumps to tickets with action-needed items', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.ingest({ ticketLabel: 'feat-a/001', kind: 'permission', message: 'perm' });
  state.ingest({ ticketLabel: 'feat-b/001', kind: 'failure', message: 'fail' });

  state.selectTicket('feat-a/002');
  state.selectNextActionNeeded();
  assert.equal(state.snapshot().selectedTicket?.label, 'feat-b/001');

  state.selectNextActionNeeded();
  assert.equal(state.snapshot().selectedTicket?.label, 'feat-a/001');

  state.selectNextActionNeeded();
  assert.equal(state.snapshot().selectedTicket?.label, 'feat-b/001');
});

test('selectNextActionNeeded keeps current selection when no action-needed items exist', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.selectTicket('feat-a/002');
  state.selectNextActionNeeded();
  assert.equal(state.snapshot().selectedTicket?.label, 'feat-a/002');
});

test('selectTicket ignores unknown labels', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.selectTicket('unknown/999');
  assert.equal(state.snapshot().selectedTicket?.label, 'feat-a/001');
});

test('empty ticket list has null selected ticket', () => {
  const state = new RunDashboardState({}, []);
  const snap = state.snapshot();
  assert.equal(snap.selectedTicket, null);
  assert.equal(snap.selectedTicketDetails, null);
  assert.equal(snap.aggregate.total, 0);
});

test('metadata ingestion enriches selected ticket details', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.ingestMetadata('feat-a/001', {
    FAILURE_KIND: 'provider-error',
    FINAL_REVIEW_OUTCOME: 'approved',
    FINAL_REVIEW_REASON: 'clean',
    FINAL_REVIEW_CLASSIFICATION: 'clean-approval',
    PHASE_HISTORY: [
      { name: 'execution', startTime: '2024-01-01T00:00:00Z', endTime: '2024-01-01T00:01:00Z', durationMs: 60000 },
    ],
  });

  const snap = state.snapshot();
  const details = snap.selectedTicketDetails;
  assert.ok(details);
  assert.equal(details.failureKind, 'provider-error');
  assert.equal(details.reviewOutcome, 'approved');
  assert.equal(details.reviewReason, 'clean');
  assert.equal(details.reviewClassification, 'clean-approval');
  assert.equal(details.phaseHistory.length, 1);
  assert.equal(details.phaseHistory[0]?.name, 'execution');
});

test('ingest with metadata enriches selected ticket details', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.ingest({
    ticketLabel: 'feat-a/001',
    message: 'run completed',
    metadata: {
      FAILURE_KIND: 'provider-error',
      FINAL_REVIEW_OUTCOME: 'approved',
      FINAL_REVIEW_REASON: 'clean',
      FINAL_REVIEW_CLASSIFICATION: 'clean-approval',
      PHASE_HISTORY: [
        { name: 'execution', startTime: '2024-01-01T00:00:00Z', endTime: '2024-01-01T00:01:00Z', durationMs: 60000 },
      ],
    },
  });

  const snap = state.snapshot();
  const details = snap.selectedTicketDetails;
  assert.ok(details);
  assert.equal(details.failureKind, 'provider-error');
  assert.equal(details.reviewOutcome, 'approved');
  assert.equal(details.reviewReason, 'clean');
  assert.equal(details.reviewClassification, 'clean-approval');
  assert.equal(details.phaseHistory.length, 1);
  assert.equal(details.phaseHistory[0]?.name, 'execution');
});

test('selected ticket details include recent events for that ticket', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.ingest({ ticketLabel: 'feat-a/001', message: 'event 1' });
  state.ingest({ ticketLabel: 'feat-a/002', message: 'event 2' });
  state.ingest({ ticketLabel: 'feat-a/001', message: 'event 3' });

  state.selectTicket('feat-a/001');
  const details = state.snapshot().selectedTicketDetails;
  assert.ok(details);
  assert.equal(details.recentEvents.length, 2);
  assert.equal(details.recentEvents[0]?.message, 'event 1');
  assert.equal(details.recentEvents[1]?.message, 'event 3');
});

test('healthCheck transitions running ticket with inactive session to complete', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.ingest({ ticketLabel: 'feat-a/001', message: 'starting ticket run', sessionId: 'sess-1' });
  assert.equal(state.snapshot().tickets.find((t) => t.label === 'feat-a/001')?.runtimeState, 'running');

  state.healthCheck(new Set(['other-sess']));
  const snap = state.snapshot();
  assert.equal(snap.tickets.find((t) => t.label === 'feat-a/001')?.runtimeState, 'complete');
  assert.equal(snap.aggregate.running, 0);
  assert.equal(snap.aggregate.complete, 1);
});

test('healthCheck preserves running ticket with active session', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.ingest({ ticketLabel: 'feat-a/001', message: 'starting ticket run', sessionId: 'sess-1' });

  state.healthCheck(new Set(['sess-1']));
  const snap = state.snapshot();
  assert.equal(snap.tickets.find((t) => t.label === 'feat-a/001')?.runtimeState, 'running');
  assert.equal(snap.aggregate.running, 1);
});

test('healthCheck does not transition running ticket without sessionId', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.ingest({ ticketLabel: 'feat-a/001', message: 'starting ticket run' });

  state.healthCheck(new Set());
  assert.equal(state.snapshot().tickets.find((t) => t.label === 'feat-a/001')?.runtimeState, 'running');
});

test('ticket title is reflected in snapshot', () => {
  const tickets: TicketRecord[] = [
    {
      path: '/tmp/a-1.md',
      feature: 'feat-a',
      issueName: '001',
      label: 'feat-a/001',
      title: 'Do the thing',
      executorAfk: true,
    },
  ];
  const state = new RunDashboardState({}, tickets);
  const snap = state.snapshot();
  assert.equal(snap.tickets[0]?.title, 'Do the thing');
  assert.equal(snap.selectedTicketDetails?.title, 'Do the thing');
});

test('completed run state renders without crashes', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.setTicketOutcome('feat-a/001', 'completed');
  state.setTicketOutcome('feat-a/002', 'completed');
  state.setTicketOutcome('feat-b/001', 'completed');

  const snap = state.snapshot();
  assert.equal(snap.aggregate.complete, 3);
  assert.equal(snap.aggregate.running, 0);
  assert.equal(snap.selectedTicket?.label, 'feat-a/001');
  assert.equal(snap.selectedTicketDetails?.runtimeState, 'complete');
});

test('default run state is running', () => {
  const state = new RunDashboardState({}, makeTickets());
  assert.equal(state.snapshot().runState, 'running');
});

test('setRunState updates snapshot runState', () => {
  const state = new RunDashboardState({}, makeTickets());
  state.setRunState('paused');
  assert.equal(state.snapshot().runState, 'paused');
  state.setRunState('running');
  assert.equal(state.snapshot().runState, 'running');
});
