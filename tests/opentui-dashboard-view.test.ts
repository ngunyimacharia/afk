import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NotificationPayload } from '../src/notification-policy.js';
import { OpenTUIDashboardView } from '../src/opentui-dashboard-view.js';
import type { DashboardNotificationState } from '../src/progress-line.js';
import type { AgentExecutionProgressEvent } from '../src/types.js';

function fakeProgressLine(): {
  events: AgentExecutionProgressEvent[];
  notificationStates: DashboardNotificationState[];
  doneCalled: boolean;
  update(event: AgentExecutionProgressEvent): void;
  updateNotificationState(state: DashboardNotificationState): void;
  done(): void;
} {
  const events: AgentExecutionProgressEvent[] = [];
  const notificationStates: DashboardNotificationState[] = [];
  let _doneCalled = false;
  return {
    events,
    notificationStates,
    update(event: AgentExecutionProgressEvent) {
      events.push(event);
    },
    updateNotificationState(state: DashboardNotificationState) {
      notificationStates.push({ ...state });
    },
    done() {
      _doneCalled = true;
    },
    get doneCalled() {
      return _doneCalled;
    },
  };
}

function samplePayload(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    title: 'Permission required: feat/001',
    message: 'bash tool requested',
    category: 'permission-required',
    ...overrides,
  };
}

test('dashboard view sets supported capability when renderer advertises notifications', () => {
  const progressLine = fakeProgressLine();
  const renderer = { capabilities: { notifications: true } };
  new OpenTUIDashboardView(progressLine, renderer);

  assert.equal(progressLine.notificationStates.length, 1);
  assert.equal(progressLine.notificationStates[0]?.capability, 'supported');
});

test('dashboard view sets unsupported capability when renderer lacks notifications', () => {
  const progressLine = fakeProgressLine();
  const renderer = { capabilities: { notifications: false } };
  new OpenTUIDashboardView(progressLine, renderer);

  assert.equal(progressLine.notificationStates.length, 1);
  assert.equal(progressLine.notificationStates[0]?.capability, 'unsupported');
});

test('dashboard view sets unsupported capability when notifications capability is missing', () => {
  const progressLine = fakeProgressLine();
  const renderer = { capabilities: {} };
  new OpenTUIDashboardView(progressLine, renderer);

  assert.equal(progressLine.notificationStates.length, 1);
  assert.equal(progressLine.notificationStates[0]?.capability, 'unsupported');
});

test('recordDelivery updates last delivery state and pushes to progress line', () => {
  const progressLine = fakeProgressLine();
  const view = new OpenTUIDashboardView(progressLine, { capabilities: { notifications: true } });

  view.recordDelivery('sent', samplePayload());

  assert.equal(progressLine.notificationStates.length, 2);
  assert.equal(progressLine.notificationStates[1]?.lastDelivery?.state, 'sent');
  assert.equal(progressLine.notificationStates[1]?.lastDelivery?.payload?.title, 'Permission required: feat/001');
});

test('recordDelivery updates with failed state', () => {
  const progressLine = fakeProgressLine();
  const view = new OpenTUIDashboardView(progressLine, { capabilities: { notifications: true } });

  view.recordDelivery('failed', samplePayload());

  assert.equal(progressLine.notificationStates.length, 2);
  assert.equal(progressLine.notificationStates[1]?.lastDelivery?.state, 'failed');
});

test('recordDelivery updates with unsupported state', () => {
  const progressLine = fakeProgressLine();
  const view = new OpenTUIDashboardView(progressLine, { capabilities: { notifications: true } });

  view.recordDelivery('unsupported', samplePayload());

  assert.equal(progressLine.notificationStates.length, 2);
  assert.equal(progressLine.notificationStates[1]?.lastDelivery?.state, 'unsupported');
});

test('recordDelivery updates with skipped state', () => {
  const progressLine = fakeProgressLine();
  const view = new OpenTUIDashboardView(progressLine, { capabilities: { notifications: true } });

  view.recordDelivery('skipped');

  assert.equal(progressLine.notificationStates.length, 2);
  assert.equal(progressLine.notificationStates[1]?.lastDelivery?.state, 'skipped');
  assert.equal(progressLine.notificationStates[1]?.lastDelivery?.payload, undefined);
});

test('getNotificationState returns a copy of current state', () => {
  const progressLine = fakeProgressLine();
  const view = new OpenTUIDashboardView(progressLine, { capabilities: { notifications: true } });

  const state1 = view.getNotificationState();
  view.recordDelivery('sent', samplePayload());
  const state2 = view.getNotificationState();

  assert.equal(state1.capability, 'supported');
  assert.equal(state1.lastDelivery, undefined);
  assert.equal(state2.capability, 'supported');
  assert.equal(state2.lastDelivery?.state, 'sent');
});

test('updateProgress delegates event to progress line', () => {
  const progressLine = fakeProgressLine();
  const view = new OpenTUIDashboardView(progressLine, { capabilities: { notifications: true } });

  const event: AgentExecutionProgressEvent = { ticketLabel: 'feat/001', message: 'starting' };
  view.updateProgress(event);

  assert.equal(progressLine.events.length, 1);
  assert.equal(progressLine.events[0]?.ticketLabel, 'feat/001');
});

test('done delegates to progress line', () => {
  const progressLine = fakeProgressLine();
  const view = new OpenTUIDashboardView(progressLine, { capabilities: { notifications: true } });

  view.done();

  assert.equal(progressLine.doneCalled, true);
});

test('unsupported capability persists even after recordDelivery', () => {
  const progressLine = fakeProgressLine();
  const view = new OpenTUIDashboardView(progressLine, { capabilities: { notifications: false } });

  view.recordDelivery('sent', samplePayload());

  assert.equal(view.getNotificationState().capability, 'unsupported');
  assert.equal(view.getNotificationState().lastDelivery?.state, 'sent');
});

test('multiple recordDelivery calls update state progressively', () => {
  const progressLine = fakeProgressLine();
  const view = new OpenTUIDashboardView(progressLine, { capabilities: { notifications: true } });

  view.recordDelivery('sent', samplePayload({ title: 'First' }));
  view.recordDelivery('failed', samplePayload({ title: 'Second' }));

  const state = view.getNotificationState();
  assert.equal(state.lastDelivery?.state, 'failed');
  assert.equal(state.lastDelivery?.payload?.title, 'Second');
  assert.equal(progressLine.notificationStates.length, 3);
});
