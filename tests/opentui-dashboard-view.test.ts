import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CliRenderer, TextRenderable } from '@opentui/core';
import type { LiveRunView } from '../src/live-run-view.js';
import { createLiveRunView } from '../src/live-run-view.js';
import type { NotificationPayload } from '../src/notification-policy.js';
import {
  createOpenTuiDashboard,
  DashboardProxy,
  formatDuration,
  formatEventTime,
  type OpenTuiDashboardModule,
} from '../src/opentui-dashboard.js';
import { OpenTUIDashboardView } from '../src/opentui-dashboard-view.js';
import type { DashboardNotificationState } from '../src/progress-line.js';
import type { AgentExecutionProgressEvent, TicketRecord } from '../src/types.js';

function fakeProgressLine(): {
  events: AgentExecutionProgressEvent[];
  notificationStates: DashboardNotificationState[];
  doneCalled: boolean;
  update(event: AgentExecutionProgressEvent): void;
  updateNotificationState(state: DashboardNotificationState): void;
  done(): void;
  cleanup(): void;
  waitForQuit(): Promise<void>;
  killRequested(): boolean;
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
    cleanup() {},
    waitForQuit() {
      return Promise.resolve();
    },
    killRequested() {
      return false;
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

test('formatDuration renders h m s consistently', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(65_000), '1m 5s');
  assert.equal(formatDuration(3_725_000), '1h 2m 5s');
});

test('formatEventTime renders weekday, ordinal day, and 12-hour time', () => {
  const ts = new Date(2024, 4, 18, 6, 34).getTime();
  const result = formatEventTime(ts);
  assert.match(result, /, 18th /);
  assert.match(result, /6:34AM$/);
});

test('formatEventTime handles ordinal suffixes correctly', () => {
  assert.match(formatEventTime(new Date(2024, 4, 1, 12, 0).getTime()), /, 1st /);
  assert.match(formatEventTime(new Date(2024, 4, 2, 12, 0).getTime()), /, 2nd /);
  assert.match(formatEventTime(new Date(2024, 4, 3, 12, 0).getTime()), /, 3rd /);
  assert.match(formatEventTime(new Date(2024, 4, 4, 12, 0).getTime()), /, 4th /);
  assert.match(formatEventTime(new Date(2024, 4, 11, 12, 0).getTime()), /, 11th /);
  assert.match(formatEventTime(new Date(2024, 4, 12, 12, 0).getTime()), /, 12th /);
  assert.match(formatEventTime(new Date(2024, 4, 13, 12, 0).getTime()), /, 13th /);
  assert.match(formatEventTime(new Date(2024, 4, 21, 12, 0).getTime()), /, 21st /);
  assert.match(formatEventTime(new Date(2024, 4, 22, 12, 0).getTime()), /, 22nd /);
  assert.match(formatEventTime(new Date(2024, 4, 23, 12, 0).getTime()), /, 23rd /);
});

test('formatEventTime handles PM correctly', () => {
  const ts = new Date(2024, 4, 18, 18, 34).getTime();
  const result = formatEventTime(ts);
  assert.match(result, /6:34PM$/);
});

test('formatEventTime handles noon as 12PM', () => {
  const ts = new Date(2024, 4, 18, 12, 0).getTime();
  const result = formatEventTime(ts);
  assert.match(result, /12:00PM$/);
});

test('formatEventTime handles midnight as 12AM', () => {
  const ts = new Date(2024, 4, 18, 0, 0).getTime();
  const result = formatEventTime(ts);
  assert.match(result, /12:00AM$/);
});

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

function fakeStdout(isTTY: boolean, writes: string[] = []): NodeJS.WriteStream {
  return {
    isTTY,
    columns: 80,
    rows: 24,
    write: (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    },
  } as NodeJS.WriteStream;
}

function makeFakeTextModule(): { texts: Map<string, string>; module: OpenTuiDashboardModule } {
  const texts = new Map<string, string>();
  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {},
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      add() {}
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      private _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string; id?: string }) {
        this._content = options.content ?? '';
        if (options.id) texts.set(options.id, this._content);
      }
      add(): number {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };
  return { texts, module };
}

const sampleTickets: TicketRecord[] = [
  {
    path: '/tmp/feat-a-001.md',
    feature: 'feat-a',
    issueName: '001',
    label: 'feat-a/001',
    executorAfk: true,
  },
];

test('live run view factory falls back to text progress line for non-tty dashboard', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(false, writes);
  const view = createLiveRunView({ kind: 'dashboard', stdout });

  view.update({ ticketLabel: 'feat-a/001', message: 'starting' });
  view.done();

  assert.deepEqual(writes, []);
});

test('createOpenTuiDashboard returns null for non-tty stdout', async () => {
  const stdout = fakeStdout(false);
  const { module } = makeFakeTextModule();
  const result = await createOpenTuiDashboard({ stdout }, module);
  assert.equal(result, null);
});

test('createOpenTuiDashboard returns null when createCliRenderer throws', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () => {
      throw new Error('renderer fail');
    },
    BoxRenderable: class {} as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class {} as unknown as OpenTuiDashboardModule['TextRenderable'],
  };
  const result = await createOpenTuiDashboard({ stdout, selectedTickets: sampleTickets }, module);
  assert.equal(result, null);
});

test('createOpenTuiDashboard creates a view that updates on events with fake module', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const { module } = makeFakeTextModule();

  const view = await createOpenTuiDashboard(
    {
      stdout,
      selectedTickets: sampleTickets,
      runOptions: { runId: 'run-123', modelId: 'model-x', harness: 'opencode', concurrency: 2 },
    },
    module,
  );

  assert.ok(view);
  view?.update({ ticketLabel: 'feat-a/001', message: 'starting ticket run' });
  view?.update({ ticketLabel: 'feat-a/001', message: 'run completed' });
  view?.done();
});

test('DashboardProxy buffers events while starting and flushes when dashboard is ready', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const { module } = makeFakeTextModule();

  let dashboardCreated = false;
  const createDashboard = async () => {
    dashboardCreated = true;
    return createOpenTuiDashboard({ stdout, selectedTickets: sampleTickets }, module);
  };

  const proxy = new DashboardProxy(stdout, {}, { stdout, selectedTickets: sampleTickets }, createDashboard);

  // Start async creation so subsequent updates are buffered
  const startPromise = proxy.start();

  // Events while starting should be buffered
  proxy.update({ ticketLabel: 'feat-a/001', message: 'event 1' });
  proxy.update({ ticketLabel: 'feat-a/001', message: 'event 2' });

  await startPromise;

  assert.equal(dashboardCreated, true);
  proxy.done();
});

test('DashboardProxy falls back to text progress when dashboard creation fails', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);

  const proxy = new DashboardProxy(stdout, {}, { stdout }, async () => null);

  proxy.update({ ticketLabel: 'feat-a/001', message: 'starting' });
  await proxy.start();
  proxy.update({ ticketLabel: 'feat-a/001', message: 'running' });
  proxy.done();

  const output = writes.join('');
  assert.match(output, /starting/);
  assert.match(output, /running/);
});

test('DashboardProxy forwards event batches to dashboard when available', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const receivedBatches: AgentExecutionProgressEvent[][] = [];
  const dashboard: LiveRunView = {
    update() {},
    updateMany(events) {
      receivedBatches.push(events);
    },
    done() {},
    cleanup() {},
    waitForQuit() {
      return Promise.resolve();
    },
    killRequested() {
      return false;
    },
  };
  const proxy = new DashboardProxy(stdout, {}, { stdout, selectedTickets: sampleTickets }, async () => dashboard);

  await proxy.start();
  proxy.updateMany([
    { ticketLabel: 'feat-a/001', message: 'event 1' },
    { ticketLabel: 'feat-a/002', message: 'event 2' },
  ]);

  assert.equal(receivedBatches.length, 1);
  assert.equal(receivedBatches[0]?.length, 2);
});

test('DashboardProxy done flushes buffered events to dashboard before calling done', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const { module } = makeFakeTextModule();

  const proxy = new DashboardProxy(stdout, {}, { stdout, selectedTickets: sampleTickets }, (opts) =>
    createOpenTuiDashboard(opts, module),
  );

  await proxy.start();

  // Manually inject a buffered event after start (simulating a race)
  const bufferedEvent: AgentExecutionProgressEvent = { ticketLabel: 'feat-a/001', message: 'buffered terminal event' };
  (proxy as unknown as { buffer: AgentExecutionProgressEvent[] }).buffer.push(bufferedEvent);

  const dashboard = (proxy as unknown as { dashboard: LiveRunView | null }).dashboard;
  assert.ok(dashboard);

  const updatedEvents: AgentExecutionProgressEvent[] = [];
  const originalUpdate = dashboard.update.bind(dashboard);
  dashboard.update = (e: AgentExecutionProgressEvent) => {
    updatedEvents.push(e);
    originalUpdate(e);
  };
  let doneCalled = false;
  const originalDone = dashboard.done.bind(dashboard);
  dashboard.done = () => {
    doneCalled = true;
    originalDone();
  };

  proxy.done();

  assert.equal(updatedEvents.length, 1);
  assert.equal(updatedEvents[0]?.message, 'buffered terminal event');
  assert.equal(doneCalled, true);
});

test('DashboardProxy cleanup flushes buffered events to dashboard before calling cleanup', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const { module } = makeFakeTextModule();

  const proxy = new DashboardProxy(stdout, {}, { stdout, selectedTickets: sampleTickets }, (opts) =>
    createOpenTuiDashboard(opts, module),
  );

  await proxy.start();

  const bufferedEvent: AgentExecutionProgressEvent = { ticketLabel: 'feat-a/001', message: 'buffered terminal event' };
  (proxy as unknown as { buffer: AgentExecutionProgressEvent[] }).buffer.push(bufferedEvent);

  const dashboard = (proxy as unknown as { dashboard: LiveRunView | null }).dashboard;
  assert.ok(dashboard);

  const updatedEvents: AgentExecutionProgressEvent[] = [];
  const originalUpdate = dashboard.update.bind(dashboard);
  dashboard.update = (e: AgentExecutionProgressEvent) => {
    updatedEvents.push(e);
    originalUpdate(e);
  };
  let cleanupCalled = false;
  const originalCleanup = dashboard.cleanup.bind(dashboard);
  dashboard.cleanup = () => {
    cleanupCalled = true;
    originalCleanup();
  };

  proxy.cleanup();

  assert.equal(updatedEvents.length, 1);
  assert.equal(updatedEvents[0]?.message, 'buffered terminal event');
  assert.equal(cleanupCalled, true);
});

test('DashboardProxy cleanup is safe to call multiple times', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const { module } = makeFakeTextModule();

  const proxy = new DashboardProxy(stdout, {}, { stdout, selectedTickets: sampleTickets }, (opts) =>
    createOpenTuiDashboard(opts, module),
  );

  proxy.update({ ticketLabel: 'feat-a/001', message: 'starting' });
  await proxy.start();
  proxy.cleanup();
  proxy.cleanup();
  proxy.done();

  assert.doesNotThrow(() => proxy.cleanup());
  assert.doesNotThrow(() => proxy.done());
});

test('createOpenTuiDashboard renders feature region with aggregate states', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);

  const boxes: Array<{ title: string; children: Array<{ content: string }> }> = [];

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {},
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      title = '';
      children: Array<{ content: string }> = [];
      constructor(_ctx: unknown, options: { title?: string }) {
        this.title = options.title ?? '';
        boxes.push(this);
      }
      add(child: { content?: string }) {
        this.children.push(child as { content: string });
      }
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const tickets: TicketRecord[] = [
    { path: '/tmp/feat-a-001.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
    { path: '/tmp/feat-a-002.md', feature: 'feat-a', issueName: '002', label: 'feat-a/002', executorAfk: true },
    { path: '/tmp/feat-b-001.md', feature: 'feat-b', issueName: '001', label: 'feat-b/001', executorAfk: true },
  ];

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: tickets }, module);
  assert.ok(view);

  view?.update({ ticketLabel: 'feat-a/001', message: 'starting ticket run' });
  view?.update({ ticketLabel: 'feat-b/001', message: 'run completed' });

  const featuresBox = boxes.find((b) => b.title === 'Features [j/k]');
  assert.ok(featuresBox, 'Features box should exist');
  const featuresContent = featuresBox.children.map((c) => c.content).join('\n');
  assert.match(featuresContent, /feat-a/);
  assert.match(featuresContent, /feat-b/);
  assert.match(featuresContent, /✅/);

  view?.done();
});

test('DashboardProxy done prevents late dashboard from taking over', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);

  let resolveCreate: (value: LiveRunView | null) => void = () => {};
  const proxy = new DashboardProxy(
    stdout,
    {},
    { stdout },
    () =>
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
  );

  proxy.update({ ticketLabel: 'feat-a/001', message: 'event before done' });

  // Start the async creation but don't await it
  const startPromise = proxy.start();

  // Call done before dashboard creation resolves
  proxy.done();

  // Now resolve the dashboard creation
  const { module } = makeFakeTextModule();
  const dashboard = await createOpenTuiDashboard({ stdout, selectedTickets: sampleTickets }, module);
  resolveCreate(dashboard);

  await startPromise;

  // The fallback should have received the event, not the dashboard
  const output = writes.join('');
  assert.match(output, /event before done/);
});

test('createOpenTuiDashboard registers keyboard input handler on renderer', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  let handlerRegistered = false;

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {},
        addInputHandler: () => {
          handlerRegistered = true;
        },
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      add() {}
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: sampleTickets }, module);
  assert.ok(view);
  assert.equal(handlerRegistered, true);
  view?.done();
});

test('createOpenTuiDashboard renders selected ticket details panel', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);

  const boxes: Array<{ title: string; children: Array<{ content: string }> }> = [];

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {},
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      title = '';
      children: Array<{ content: string }> = [];
      constructor(_ctx: unknown, options: { title?: string }) {
        this.title = options.title ?? '';
        boxes.push(this);
      }
      add(child: { content?: string }) {
        this.children.push(child as { content: string });
      }
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const tickets: TicketRecord[] = [
    { path: '/tmp/feat-a-001.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
  ];

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: tickets, repoRoot: '/tmp' }, module);
  assert.ok(view);

  view?.update({ ticketLabel: 'feat-a/001', message: 'starting ticket run', sessionId: 'sess-1' });

  const detailsBox = boxes.find((b) => b.title === 'Details');
  assert.ok(detailsBox, 'Details box should exist');
  const detailsContent = detailsBox.children.map((c) => c.content).join('\n');
  assert.match(detailsContent, /001/);
  assert.match(detailsContent, /⏳/);
  assert.match(detailsContent, /sess-1/);
  assert.match(detailsContent, /Path: feat-a-001\.md/);

  view?.done();
});

test('createOpenTuiDashboard renders metadata in selected ticket details panel', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);

  const boxes: Array<{ title: string; children: Array<{ content: string }> }> = [];

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {},
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      title = '';
      children: Array<{ content: string }> = [];
      constructor(_ctx: unknown, options: { title?: string }) {
        this.title = options.title ?? '';
        boxes.push(this);
      }
      add(child: { content?: string }) {
        this.children.push(child as { content: string });
      }
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const tickets: TicketRecord[] = [
    { path: '/tmp/feat-a-001.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
  ];

  const view = await createOpenTuiDashboard(
    {
      stdout,
      selectedTickets: tickets,
      repoRoot: '/tmp',
      runOptions: { runId: 'run-123', modelId: 'model-x', harness: 'opencode' },
    },
    module,
  );
  assert.ok(view);

  view?.update({
    ticketLabel: 'feat-a/001',
    message: 'run completed',
    sessionId: 'sess-1',
    metadata: {
      FAILURE_KIND: null,
      FINAL_REVIEW_OUTCOME: 'approved',
      FINAL_REVIEW_REASON: 'clean',
      FINAL_REVIEW_CLASSIFICATION: 'clean-approval',
      PHASE_HISTORY: [
        { name: 'execution', startTime: '2024-01-01T00:00:00Z', endTime: '2024-01-01T00:01:00Z', durationMs: 60000 },
      ],
    },
  });

  const detailsBox = boxes.find((b) => b.title === 'Details');
  assert.ok(detailsBox, 'Details box should exist');
  const detailsContent = detailsBox.children.map((c) => c.content).join('\n');
  assert.match(detailsContent, /001/);
  assert.match(detailsContent, /✅/);
  assert.match(detailsContent, /Path: feat-a-001\.md/);
  assert.match(detailsContent, /Model: model-x/);
  assert.match(detailsContent, /Harness: opencode/);
  assert.match(detailsContent, /Review: approved \(clean\)/);
  assert.match(detailsContent, /Phases:/);
  assert.match(detailsContent, /execution 1m/);
  assert.doesNotMatch(detailsContent, /Recent events:/);

  view?.done();
});

test('createOpenTuiDashboard strips feature prefix from labels and formats paths', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);

  const boxes: Array<{ title: string; children: Array<{ content: string }> }> = [];

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {},
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      title = '';
      children: Array<{ content: string }> = [];
      constructor(_ctx: unknown, options: { title?: string }) {
        this.title = options.title ?? '';
        boxes.push(this);
      }
      add(child: { content?: string }) {
        this.children.push(child as { content: string });
      }
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const tickets: TicketRecord[] = [
    {
      path: '/repo/.scratch/feat-a/issues/01-do-thing.md',
      feature: 'feat-a',
      issueName: '01-do-thing',
      label: 'feat-a/01-do-thing',
      executorAfk: true,
    },
    { path: '/outside/02-other.md', feature: 'feat-b', issueName: '02-other', label: 'no-slash', executorAfk: true },
  ];

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: tickets, repoRoot: '/repo' }, module);
  assert.ok(view);

  view?.update({ ticketLabel: 'feat-a/01-do-thing', message: 'starting' });
  view?.update({ ticketLabel: 'no-slash', message: 'running' });

  const ticketsBox = boxes.find((b) => b.title === 'Tickets [j/k]');
  assert.ok(ticketsBox, 'Tickets box should exist');
  const ticketsContent = ticketsBox.children.map((c) => c.content).join('\n');
  assert.match(ticketsContent, /> 01-do-thing/);
  assert.match(ticketsContent, /no-slash/);

  const eventsBox = boxes.find((b) => b.title === 'Recent Events');
  assert.ok(eventsBox, 'Recent Events box should exist');
  const eventsContent = eventsBox.children.map((c) => c.content).join('\n');
  assert.match(eventsContent, /01-do-thing: starting/);
  assert.match(eventsContent, /no-slash: running/);

  const detailsBox = boxes.find((b) => b.title === 'Details');
  assert.ok(detailsBox, 'Details box should exist');
  const detailsContent = detailsBox.children.map((c) => c.content).join('\n');
  assert.match(detailsContent, /01-do-thing/);
  assert.match(detailsContent, /Path: \.scratch\/feat-a\/issues\/01-do-thing\.md/);

  // Select the second ticket to check outside-repo path formatting
  (view as unknown as { handleKey(sequence: string): boolean }).handleKey('j');
  const detailsContent2 = detailsBox.children.map((c) => c.content).join('\n');
  assert.match(detailsContent2, /no-slash/);
  assert.match(detailsContent2, /Path: 02-other\.md/);

  view?.done();
});

test('createOpenTuiDashboard renders ticket title alongside issue name', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);

  const boxes: Array<{ title: string; children: Array<{ content: string }> }> = [];

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {},
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      title = '';
      children: Array<{ content: string }> = [];
      constructor(_ctx: unknown, options: { title?: string }) {
        this.title = options.title ?? '';
        boxes.push(this);
      }
      add(child: { content?: string }) {
        this.children.push(child as { content: string });
      }
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const tickets: TicketRecord[] = [
    {
      path: '/tmp/feat-a-001.md',
      feature: 'feat-a',
      issueName: 'afk-123',
      label: 'feat-a/afk-123',
      title: 'Fix the thing',
      executorAfk: true,
    },
  ];

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: tickets, repoRoot: '/tmp' }, module);
  assert.ok(view);

  view?.update({ ticketLabel: 'feat-a/afk-123', message: 'starting' });

  const ticketsBox = boxes.find((b) => b.title === 'Tickets [j/k]');
  assert.ok(ticketsBox, 'Tickets box should exist');
  const ticketsContent = ticketsBox.children.map((c) => c.content).join('\n');
  assert.match(ticketsContent, /> afk-123: Fix the thing/);

  const detailsBox = boxes.find((b) => b.title === 'Details');
  assert.ok(detailsBox, 'Details box should exist');
  const detailsContent = detailsBox.children.map((c) => c.content).join('\n');
  assert.match(detailsContent, /Title: Fix the thing/);

  view?.done();
});

test('createOpenTuiDashboard renders panel titles with keyboard hints', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);

  const boxes: Array<{ title: string; children: Array<{ content: string }> }> = [];

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {},
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      title = '';
      children: Array<{ content: string }> = [];
      constructor(_ctx: unknown, options: { title?: string }) {
        this.title = options.title ?? '';
        boxes.push(this);
      }
      add(child: { content?: string }) {
        this.children.push(child as { content: string });
      }
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const tickets: TicketRecord[] = [
    { path: '/tmp/feat-a-001.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
  ];

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: tickets }, module);
  assert.ok(view);

  assert.ok(
    boxes.some((b) => b.title === 'Features [j/k]'),
    'Features title should include hint',
  );
  assert.ok(
    boxes.some((b) => b.title === 'Tickets [j/k]'),
    'Tickets title should include hint',
  );
  assert.ok(
    boxes.some((b) => b.title === 'Action Needed [a]'),
    'Action Needed title should include hint',
  );
  assert.ok(
    boxes.some((b) => b.title === 'Details'),
    'Details title should not have hint',
  );

  view?.done();
});

test('createOpenTuiDashboard renders timestamps in recent events panel', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);

  const boxes: Array<{ title: string; children: Array<{ content: string }> }> = [];

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {},
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      title = '';
      children: Array<{ content: string }> = [];
      constructor(_ctx: unknown, options: { title?: string }) {
        this.title = options.title ?? '';
        boxes.push(this);
      }
      add(child: { content?: string }) {
        this.children.push(child as { content: string });
      }
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const tickets: TicketRecord[] = [
    { path: '/tmp/feat-a-001.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
  ];

  const view = await createOpenTuiDashboard(
    {
      stdout,
      selectedTickets: tickets,
      runOptions: { startTime: 1715999999000, now: () => 1716000000000 },
    },
    module,
  );
  assert.ok(view);

  view?.update({ ticketLabel: 'feat-a/001', message: 'starting ticket run' });
  view?.update({ ticketLabel: 'feat-a/001', message: 'run completed' });

  const eventsBox = boxes.find((b) => b.title === 'Recent Events');
  assert.ok(eventsBox, 'Recent Events box should exist');
  const eventsContent = eventsBox.children.map((c) => c.content).join('\n');
  assert.match(eventsContent, /^[A-Z][a-z]{2}, \d{1,2}(st|nd|rd|th) \d{1,2}:\d{2}(AM|PM) 001: run completed$/m);

  view?.done();
});

test('createOpenTuiDashboard flattens multiline event messages', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);

  const boxes: Array<{ title: string; children: Array<{ content: string }> }> = [];

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {},
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      title = '';
      children: Array<{ content: string }> = [];
      constructor(_ctx: unknown, options: { title?: string }) {
        this.title = options.title ?? '';
        boxes.push(this);
      }
      add(child: { content?: string }) {
        this.children.push(child as { content: string });
      }
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const tickets: TicketRecord[] = [
    { path: '/tmp/feat-a-001.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
  ];

  const view = await createOpenTuiDashboard(
    {
      stdout,
      selectedTickets: tickets,
      runOptions: { startTime: 1715999999000, now: () => 1716000000000 },
    },
    module,
  );
  assert.ok(view);

  view?.update({
    ticketLabel: 'feat-a/001',
    message: 'error: line one\nline two\nline three',
    kind: 'failure',
  });

  const eventsBox = boxes.find((b) => b.title === 'Recent Events');
  assert.ok(eventsBox, 'Recent Events box should exist');
  const eventsContent = eventsBox.children.map((c) => c.content).join('\n');
  assert.doesNotMatch(eventsContent, /line one\nline two/);
  assert.match(eventsContent, /line one line two line three/);

  view?.done();
});

test('createOpenTuiDashboard renders empty state when no tickets', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);

  const boxes: Array<{ title: string; children: Array<{ content: string }> }> = [];

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {},
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      title = '';
      children: Array<{ content: string }> = [];
      constructor(_ctx: unknown, options: { title?: string }) {
        this.title = options.title ?? '';
        boxes.push(this);
      }
      add(child: { content?: string }) {
        this.children.push(child as { content: string });
      }
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: [] }, module);
  assert.ok(view);

  const detailsBox = boxes.find((b) => b.title === 'Details');
  assert.ok(detailsBox, 'Details box should exist');
  const detailsContent = detailsBox.children.map((c) => c.content).join('\n');
  assert.match(detailsContent, /No tickets in run/);

  view?.done();
});

test('createOpenTuiDashboard ticket list shows selection indicator', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);

  const boxes: Array<{ title: string; children: Array<{ content: string }> }> = [];

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {},
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      title = '';
      children: Array<{ content: string }> = [];
      constructor(_ctx: unknown, options: { title?: string }) {
        this.title = options.title ?? '';
        boxes.push(this);
      }
      add(child: { content?: string }) {
        this.children.push(child as { content: string });
      }
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const tickets: TicketRecord[] = [
    { path: '/tmp/feat-a-001.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
    { path: '/tmp/feat-a-002.md', feature: 'feat-a', issueName: '002', label: 'feat-a/002', executorAfk: true },
  ];

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: tickets }, module);
  assert.ok(view);

  const ticketsBox = boxes.find((b) => b.title === 'Tickets [j/k]');
  assert.ok(ticketsBox, 'Tickets box should exist');
  const ticketsContent = ticketsBox.children.map((c) => c.content).join('\n');
  assert.match(ticketsContent, /> 001/);
  assert.match(ticketsContent, / {2}002/);

  view?.done();
});

test('createOpenTuiDashboard starts a 1-second refresh timer on creation', async () => {
  const origSetInterval = global.setInterval;
  const origClearInterval = global.clearInterval;
  let intervalDelay = 0;
  let intervalCallback: (() => void) | null = null;

  global.setInterval = ((callback: () => void, delay: number) => {
    intervalDelay = delay;
    intervalCallback = callback;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof global.setInterval;
  global.clearInterval = () => {};

  try {
    const stdout = fakeStdout(true);
    const { module } = makeFakeTextModule();
    const view = await createOpenTuiDashboard({ stdout, selectedTickets: sampleTickets }, module);
    assert.ok(view);
    assert.equal(intervalDelay, 200);
    assert.ok(intervalCallback);
    view?.done();
  } finally {
    global.setInterval = origSetInterval;
    global.clearInterval = origClearInterval;
  }
});

test('createOpenTuiDashboard stops timer when all tickets are terminal', async () => {
  const origSetInterval = global.setInterval;
  const origClearInterval = global.clearInterval;
  let cleared = false;
  const callbacks: Array<() => void> = [];

  global.setInterval = ((callback: () => void, _delay: number) => {
    callbacks.push(callback);
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof global.setInterval;
  global.clearInterval = () => {
    cleared = true;
  };

  try {
    const stdout = fakeStdout(true);
    const { module } = makeFakeTextModule();
    const view = await createOpenTuiDashboard({ stdout, selectedTickets: sampleTickets }, module);
    assert.ok(view);
    assert.ok(callbacks.length > 0);

    view?.update({ ticketLabel: 'feat-a/001', message: 'run completed' });
    callbacks[0]?.();

    assert.equal(cleared, true);
    view?.done();
  } finally {
    global.setInterval = origSetInterval;
    global.clearInterval = origClearInterval;
  }
});

test('createOpenTuiDashboard keeps timer running before replay creates tickets', async () => {
  const origSetInterval = global.setInterval;
  const origClearInterval = global.clearInterval;
  let cleared = false;

  global.setInterval = ((_callback: () => void, _delay: number) => {
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof global.setInterval;
  global.clearInterval = () => {
    cleared = true;
  };

  try {
    const stdout = fakeStdout(true);
    const { module } = makeFakeTextModule();
    const view = await createOpenTuiDashboard({ stdout, selectedTickets: [] }, module);
    assert.ok(view);
    assert.equal(cleared, false);
    view?.done();
  } finally {
    global.setInterval = origSetInterval;
    global.clearInterval = origClearInterval;
  }
});

test('createOpenTuiDashboard clears timer on done', async () => {
  const origSetInterval = global.setInterval;
  const origClearInterval = global.clearInterval;
  let cleared = false;

  global.setInterval = ((_callback: () => void, _delay: number) => {
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof global.setInterval;
  global.clearInterval = () => {
    cleared = true;
  };

  try {
    const stdout = fakeStdout(true);
    const { module } = makeFakeTextModule();
    const view = await createOpenTuiDashboard({ stdout, selectedTickets: sampleTickets }, module);
    assert.ok(view);
    view?.done();
    assert.equal(cleared, true);
  } finally {
    global.setInterval = origSetInterval;
    global.clearInterval = origClearInterval;
  }
});

test('createOpenTuiDashboard clears timer on cleanup', async () => {
  const origSetInterval = global.setInterval;
  const origClearInterval = global.clearInterval;
  let cleared = false;

  global.setInterval = ((_callback: () => void, _delay: number) => {
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof global.setInterval;
  global.clearInterval = () => {
    cleared = true;
  };

  try {
    const stdout = fakeStdout(true);
    const { module } = makeFakeTextModule();
    const view = await createOpenTuiDashboard({ stdout, selectedTickets: sampleTickets }, module);
    assert.ok(view);
    view?.cleanup();
    assert.equal(cleared, true);
  } finally {
    global.setInterval = origSetInterval;
    global.clearInterval = origClearInterval;
  }
});

test('createOpenTuiDashboard renders static icons for non-running ticket states', async () => {
  const stdout = fakeStdout(true);

  const boxes: Array<{ title: string; children: Array<{ content: string }> }> = [];

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {},
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      title = '';
      children: Array<{ content: string }> = [];
      constructor(_ctx: unknown, options: { title?: string }) {
        this.title = options.title ?? '';
        boxes.push(this);
      }
      add(child: { content?: string }) {
        this.children.push(child as { content: string });
      }
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const tickets: TicketRecord[] = [
    { path: '/tmp/feat-a-001.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
  ];

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: tickets }, module);
  assert.ok(view);

  view?.update({ ticketLabel: 'feat-a/001', message: 'run completed' });

  const ticketsBox = boxes.find((b) => b.title === 'Tickets [j/k]');
  assert.ok(ticketsBox);
  const content = ticketsBox.children.map((c) => c.content).join('\n');
  assert.match(content, /✅/);

  view?.done();
});

test('createOpenTuiDashboard cycles braille spinner for running tickets on timer tick', async () => {
  const origSetInterval = global.setInterval;
  const origClearInterval = global.clearInterval;
  const callbacks: Array<() => void> = [];

  global.setInterval = ((callback: () => void, _delay: number) => {
    callbacks.push(callback);
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof global.setInterval;
  global.clearInterval = () => {};

  try {
    const stdout = fakeStdout(true);

    const boxes: Array<{ title: string; children: Array<{ content: string }> }> = [];

    const module: OpenTuiDashboardModule = {
      createCliRenderer: async () =>
        ({
          root: { add: () => {} },
          destroy: () => {},
          addInputHandler: () => {},
          removeInputHandler: () => {},
        }) as unknown as CliRenderer,
      BoxRenderable: class FakeBox {
        title = '';
        children: Array<{ content: string }> = [];
        constructor(_ctx: unknown, options: { title?: string }) {
          this.title = options.title ?? '';
          boxes.push(this);
        }
        add(child: { content?: string }) {
          this.children.push(child as { content: string });
        }
      } as unknown as OpenTuiDashboardModule['BoxRenderable'],
      TextRenderable: class FakeText {
        _content = '';
        get content(): string {
          return this._content;
        }
        set content(value: string | { toString(): string }) {
          if (
            value &&
            typeof value === 'object' &&
            'chunks' in value &&
            Array.isArray((value as Record<string, unknown>).chunks)
          ) {
            this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
              .map((c) => c.text)
              .join('');
          } else {
            this._content = String(value);
          }
        }
        constructor(_ctx: unknown, options: { content?: string }) {
          this._content = options.content ?? '';
        }
        add() {
          return 0;
        }
        remove() {}
        clear() {}
        destroy() {}
        onLifecyclePass = () => {};
        textNode = undefined as unknown as TextRenderable['textNode'];
        chunks = [];
        getTextChildren() {
          return [];
        }
        insertBefore(): number {
          return 0;
        }
      } as unknown as OpenTuiDashboardModule['TextRenderable'],
    };

    const tickets: TicketRecord[] = [
      { path: '/tmp/feat-a-001.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
    ];

    const view = await createOpenTuiDashboard({ stdout, selectedTickets: tickets }, module);
    assert.ok(view);

    view?.update({ ticketLabel: 'feat-a/001', message: 'starting ticket run' });

    const ticketsBoxBefore = boxes.find((b) => b.title === 'Tickets [j/k]');
    assert.ok(ticketsBoxBefore);
    const contentBefore = ticketsBoxBefore.children.map((c) => c.content).join('\n');
    assert.match(contentBefore, /[⠋⠙⠹⠸]/);

    callbacks[0]?.();

    const ticketsBoxAfter = boxes.find((b) => b.title === 'Tickets [j/k]');
    assert.ok(ticketsBoxAfter);
    const contentAfter = ticketsBoxAfter.children.map((c) => c.content).join('\n');
    assert.match(contentAfter, /[⠋⠙⠹⠸]/);

    view?.done();
  } finally {
    global.setInterval = origSetInterval;
    global.clearInterval = origClearInterval;
  }
});

test('createOpenTuiDashboard uses equal 25% column widths and proportional flexGrow', async () => {
  const stdout = fakeStdout(true);

  const boxes: Array<{
    title: string;
    width?: number | string;
    flexGrow?: number;
    children: Array<{ content: string }>;
  }> = [];

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {},
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      title = '';
      width: number | string | undefined;
      flexGrow: number | undefined;
      children: Array<{ content: string }> = [];
      constructor(_ctx: unknown, options: { title?: string; width?: number | string; flexGrow?: number }) {
        this.title = options.title ?? '';
        this.width = options.width;
        this.flexGrow = options.flexGrow;
        boxes.push(this);
      }
      add(child: { content?: string }) {
        this.children.push(child as { content: string });
      }
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const tickets: TicketRecord[] = [
    { path: '/tmp/feat-a-001.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
  ];

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: tickets }, module);
  assert.ok(view);

  assert.equal(boxes.find((b) => b.title === 'Features [j/k]')?.width, '25%');
  assert.equal(boxes.find((b) => b.title === 'Tickets [j/k]')?.width, '25%');
  assert.equal(boxes.find((b) => b.title === 'Action Needed [a]')?.width, '25%');
  assert.equal(boxes.find((b) => b.title === 'Details')?.width, '25%');
  assert.equal(boxes.find((b) => b.title === 'Recent Events')?.flexGrow, 1);

  const contentBox = boxes.find((b) => b.title === '' && b.flexGrow === 2);
  assert.ok(contentBox, 'content row should have flexGrow 2');

  view?.done();
});

test('createOpenTuiDashboard shows completion banner in header when all tickets are terminal', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);

  const boxes: Array<{ title: string; children: Array<{ content: string }> }> = [];

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {},
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      title = '';
      children: Array<{ content: string }> = [];
      constructor(_ctx: unknown, options: { title?: string }) {
        this.title = options.title ?? '';
        boxes.push(this);
      }
      add(child: { content?: string }) {
        this.children.push(child as { content: string });
      }
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const tickets: TicketRecord[] = [
    { path: '/tmp/feat-a-001.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
    { path: '/tmp/feat-a-002.md', feature: 'feat-a', issueName: '002', label: 'feat-a/002', executorAfk: true },
  ];

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: tickets }, module);
  assert.ok(view);

  view?.update({ ticketLabel: 'feat-a/001', message: 'run completed' });
  view?.update({ ticketLabel: 'feat-a/002', message: 'run completed' });

  const headerBox = boxes.find((b) => b.title === 'AFK Run Dashboard');
  assert.ok(headerBox, 'Header box should exist');
  const headerContent = headerBox.children.map((c) => c.content).join('\n');
  assert.match(headerContent, /All tasks complete/);

  view?.done();
});

test('createOpenTuiDashboard renders repo root in header', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);

  const boxes: Array<{ title: string; children: Array<{ content: string }> }> = [];

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {},
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      title = '';
      children: Array<{ content: string }> = [];
      constructor(_ctx: unknown, options: { title?: string }) {
        this.title = options.title ?? '';
        boxes.push(this);
      }
      add(child: { content?: string }) {
        this.children.push(child as { content: string });
      }
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const tickets: TicketRecord[] = [
    { path: '/tmp/feat-a-001.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
  ];

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: tickets, repoRoot: '/my/repo' }, module);
  assert.ok(view);

  const headerBox = boxes.find((b) => b.title === 'AFK Run Dashboard');
  assert.ok(headerBox, 'Header box should exist');
  const headerContent = headerBox.children.map((c) => c.content).join('\n');
  assert.match(headerContent, /Repo: \/my\/repo/);

  view?.done();
});

test('createOpenTuiDashboard done destroys renderer even when run is complete', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  let destroyCalled = false;

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {
          destroyCalled = true;
        },
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      add() {}
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const tickets: TicketRecord[] = [
    { path: '/tmp/feat-a-001.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
  ];

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: tickets }, module);
  assert.ok(view);

  view?.update({ ticketLabel: 'feat-a/001', message: 'run completed' });
  view?.done();

  assert.equal(destroyCalled, true);
});

test('createOpenTuiDashboard done destroys renderer when run is incomplete', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  let destroyCalled = false;

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {
          destroyCalled = true;
        },
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      add() {}
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const tickets: TicketRecord[] = [
    { path: '/tmp/feat-a-001.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
  ];

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: tickets }, module);
  assert.ok(view);

  // Do not send a terminal event; ticket stays in 'ready' state
  view?.done();

  assert.equal(destroyCalled, true);
});

test('createOpenTuiDashboard renders footer with default quit hint', async () => {
  const stdout = fakeStdout(true);
  const contents: string[] = [];

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {},
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      add() {}
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
        contents.push(this._content);
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
        contents.push(this._content);
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: sampleTickets }, module);
  assert.ok(view);
  assert.ok(contents.includes('p to pause | q to quit | k to kill'));
  view?.done();
});

test('createOpenTuiDashboard pressing q arms quit and updates footer', async () => {
  const stdout = fakeStdout(true);
  const contents: string[] = [];
  let destroyCalled = false;

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {
          destroyCalled = true;
        },
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      add() {}
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
        contents.push(this._content);
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
        contents.push(this._content);
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: sampleTickets }, module);
  assert.ok(view);

  const dashboard = view as unknown as { handleKey(sequence: string): boolean };
  const handled = dashboard.handleKey('q');
  assert.equal(handled, true);
  assert.ok(contents.includes('Press again to quit'));
  assert.equal(destroyCalled, false);

  view?.done();
});

test('createOpenTuiDashboard pressing q twice destroys renderer', async () => {
  const stdout = fakeStdout(true);
  let destroyCalled = false;

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {
          destroyCalled = true;
        },
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      add() {}
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: sampleTickets }, module);
  assert.ok(view);

  const dashboard = view as unknown as { handleKey(sequence: string): boolean };

  dashboard.handleKey('q');
  assert.equal(destroyCalled, false);

  dashboard.handleKey('q');
  assert.equal(destroyCalled, true);
});

test('createOpenTuiDashboard pressing Ctrl+C twice destroys renderer', async () => {
  const stdout = fakeStdout(true);
  let destroyCalled = false;

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {
          destroyCalled = true;
        },
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      add() {}
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: sampleTickets }, module);
  assert.ok(view);

  const dashboard = view as unknown as { handleKey(sequence: string): boolean };

  dashboard.handleKey('\x03');
  assert.equal(destroyCalled, false);

  dashboard.handleKey('\x03');
  assert.equal(destroyCalled, true);
});

test('createOpenTuiDashboard quit auto-disarms after timeout', async () => {
  const origSetTimeout = global.setTimeout;
  const origClearTimeout = global.clearTimeout;
  let timeoutCallback: unknown = null;
  let timeoutDelay = 0;

  global.setTimeout = ((callback: () => void, delay: number) => {
    timeoutCallback = callback;
    timeoutDelay = delay;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof global.setTimeout;
  global.clearTimeout = () => {};

  try {
    const stdout = fakeStdout(true);
    const contents: string[] = [];

    const module: OpenTuiDashboardModule = {
      createCliRenderer: async () =>
        ({
          root: { add: () => {} },
          destroy: () => {},
          addInputHandler: () => {},
          removeInputHandler: () => {},
        }) as unknown as CliRenderer,
      BoxRenderable: class FakeBox {
        add() {}
      } as unknown as OpenTuiDashboardModule['BoxRenderable'],
      TextRenderable: class FakeText {
        _content = '';
        get content(): string {
          return this._content;
        }
        set content(value: string | { toString(): string }) {
          if (
            value &&
            typeof value === 'object' &&
            'chunks' in value &&
            Array.isArray((value as Record<string, unknown>).chunks)
          ) {
            this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
              .map((c) => c.text)
              .join('');
          } else {
            this._content = String(value);
          }
          contents.push(this._content);
        }
        constructor(_ctx: unknown, options: { content?: string }) {
          this._content = options.content ?? '';
          contents.push(this._content);
        }
        add() {
          return 0;
        }
        remove() {}
        clear() {}
        destroy() {}
        onLifecyclePass = () => {};
        textNode = undefined as unknown as TextRenderable['textNode'];
        chunks = [];
        getTextChildren() {
          return [];
        }
        insertBefore(): number {
          return 0;
        }
      } as unknown as OpenTuiDashboardModule['TextRenderable'],
    };

    const view = await createOpenTuiDashboard({ stdout, selectedTickets: sampleTickets }, module);
    assert.ok(view);

    const dashboard = view as unknown as { handleKey(sequence: string): boolean };

    dashboard.handleKey('q');
    assert.ok(contents.includes('Press again to quit'));
    assert.equal(timeoutDelay, 2000);

    // Simulate timeout firing
    if (typeof timeoutCallback === 'function') (timeoutCallback as () => void)();

    assert.ok(contents.includes('p to pause | q to quit | k to kill'));
    view?.done();
  } finally {
    global.setTimeout = origSetTimeout;
    global.clearTimeout = origClearTimeout;
  }
});

test('createOpenTuiDashboard other keys work normally when quit is not armed', async () => {
  const stdout = fakeStdout(true);

  const boxes: Array<{ title: string; children: Array<{ content: string }> }> = [];

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {},
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      title = '';
      children: Array<{ content: string }> = [];
      constructor(_ctx: unknown, options: { title?: string }) {
        this.title = options.title ?? '';
        boxes.push(this);
      }
      add(child: { content?: string }) {
        this.children.push(child as { content: string });
      }
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const tickets: TicketRecord[] = [
    { path: '/tmp/feat-a-001.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
    { path: '/tmp/feat-a-002.md', feature: 'feat-a', issueName: '002', label: 'feat-a/002', executorAfk: true },
  ];

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: tickets }, module);
  assert.ok(view);

  const dashboard = view as unknown as { handleKey(sequence: string): boolean };

  const ticketsBox = boxes.find((b) => b.title === 'Tickets [j/k]');
  assert.ok(ticketsBox);
  const contentBefore = ticketsBox.children.map((c) => c.content).join('\n');
  assert.match(contentBefore, /> 001/);

  const handled = dashboard.handleKey('j');
  assert.equal(handled, true);

  const contentAfter = ticketsBox.children.map((c) => c.content).join('\n');
  assert.match(contentAfter, /> 002/);

  view?.done();
});

test('createOpenTuiDashboard cleanup destroys renderer even when run is complete', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  let destroyCalled = false;

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {
          destroyCalled = true;
        },
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      add() {}
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const tickets: TicketRecord[] = [
    { path: '/tmp/feat-a-001.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
  ];

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: tickets }, module);
  assert.ok(view);

  view?.update({ ticketLabel: 'feat-a/001', message: 'run completed' });
  view?.cleanup();

  assert.equal(destroyCalled, true);
});

test('createOpenTuiDashboard handleKey remains active after maybeStopTimer fires', async () => {
  const origSetInterval = global.setInterval;
  const origClearInterval = global.clearInterval;
  const callbacks: Array<() => void> = [];

  global.setInterval = ((callback: () => void, _delay: number) => {
    callbacks.push(callback);
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof global.setInterval;
  global.clearInterval = () => {};

  try {
    const stdout = fakeStdout(true);

    const boxes: Array<{ title: string; children: Array<{ content: string }> }> = [];

    const module: OpenTuiDashboardModule = {
      createCliRenderer: async () =>
        ({
          root: { add: () => {} },
          destroy: () => {},
          addInputHandler: () => {},
          removeInputHandler: () => {},
        }) as unknown as CliRenderer,
      BoxRenderable: class FakeBox {
        title = '';
        children: Array<{ content: string }> = [];
        constructor(_ctx: unknown, options: { title?: string }) {
          this.title = options.title ?? '';
          boxes.push(this);
        }
        add(child: { content?: string }) {
          this.children.push(child as { content: string });
        }
      } as unknown as OpenTuiDashboardModule['BoxRenderable'],
      TextRenderable: class FakeText {
        _content = '';
        get content(): string {
          return this._content;
        }
        set content(value: string | { toString(): string }) {
          if (
            value &&
            typeof value === 'object' &&
            'chunks' in value &&
            Array.isArray((value as Record<string, unknown>).chunks)
          ) {
            this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
              .map((c) => c.text)
              .join('');
          } else {
            this._content = String(value);
          }
        }
        constructor(_ctx: unknown, options: { content?: string }) {
          this._content = options.content ?? '';
        }
        add() {
          return 0;
        }
        remove() {}
        clear() {}
        destroy() {}
        onLifecyclePass = () => {};
        textNode = undefined as unknown as TextRenderable['textNode'];
        chunks = [];
        getTextChildren() {
          return [];
        }
        insertBefore(): number {
          return 0;
        }
      } as unknown as OpenTuiDashboardModule['TextRenderable'],
    };

    const tickets: TicketRecord[] = [
      { path: '/tmp/feat-a-001.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
      { path: '/tmp/feat-a-002.md', feature: 'feat-a', issueName: '002', label: 'feat-a/002', executorAfk: true },
    ];

    const view = await createOpenTuiDashboard({ stdout, selectedTickets: tickets }, module);
    assert.ok(view);

    // Send terminal event to stop the timer via maybeStopTimer
    view?.update({ ticketLabel: 'feat-a/001', message: 'run completed' });
    view?.update({ ticketLabel: 'feat-a/002', message: 'run completed' });
    callbacks[0]?.();

    // handleKey should still work after timer stops
    const dashboard = view as unknown as { handleKey(sequence: string): boolean };
    const ticketsBox = boxes.find((b) => b.title === 'Tickets [j/k]');
    assert.ok(ticketsBox);

    const handled = dashboard.handleKey('j');
    assert.equal(handled, true);

    const contentAfter = ticketsBox.children.map((c) => c.content).join('\n');
    assert.match(contentAfter, /> 002/);

    view?.done();
  } finally {
    global.setInterval = origSetInterval;
    global.clearInterval = origClearInterval;
  }
});

test('createOpenTuiDashboard waitForQuit resolves when confirmQuit is called', async () => {
  const stdout = fakeStdout(true);
  let destroyCalled = false;

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {
          destroyCalled = true;
        },
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      add() {}
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: sampleTickets }, module);
  assert.ok(view);

  const dashboard = view as unknown as { handleKey(sequence: string): boolean; waitForQuit(): Promise<void> };

  const quitPromise = dashboard.waitForQuit();
  let resolved = false;
  quitPromise.then(() => {
    resolved = true;
  });

  // First press arms quit
  dashboard.handleKey('q');
  assert.equal(destroyCalled, false);
  assert.equal(resolved, false);

  // Second press confirms quit
  dashboard.handleKey('q');
  assert.equal(destroyCalled, true);

  // Promise should resolve
  await quitPromise;
  assert.equal(resolved, true);
});

test('createOpenTuiDashboard waitForQuit resolves when done is called', async () => {
  const stdout = fakeStdout(true);

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {},
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      add() {}
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: sampleTickets }, module);
  assert.ok(view);

  const quitPromise = view.waitForQuit();
  view.done();

  await quitPromise;
});

test('createOpenTuiDashboard waitForQuit resolves when cleanup is called', async () => {
  const stdout = fakeStdout(true);

  const module: OpenTuiDashboardModule = {
    createCliRenderer: async () =>
      ({
        root: { add: () => {} },
        destroy: () => {},
        addInputHandler: () => {},
        removeInputHandler: () => {},
      }) as unknown as CliRenderer,
    BoxRenderable: class FakeBox {
      add() {}
    } as unknown as OpenTuiDashboardModule['BoxRenderable'],
    TextRenderable: class FakeText {
      _content = '';
      get content(): string {
        return this._content;
      }
      set content(value: string | { toString(): string }) {
        if (
          value &&
          typeof value === 'object' &&
          'chunks' in value &&
          Array.isArray((value as Record<string, unknown>).chunks)
        ) {
          this._content = ((value as Record<string, unknown>).chunks as Array<{ text: string }>)
            .map((c) => c.text)
            .join('');
        } else {
          this._content = String(value);
        }
      }
      constructor(_ctx: unknown, options: { content?: string }) {
        this._content = options.content ?? '';
      }
      add() {
        return 0;
      }
      remove() {}
      clear() {}
      destroy() {}
      onLifecyclePass = () => {};
      textNode = undefined as unknown as TextRenderable['textNode'];
      chunks = [];
      getTextChildren() {
        return [];
      }
      insertBefore(): number {
        return 0;
      }
    } as unknown as OpenTuiDashboardModule['TextRenderable'],
  };

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: sampleTickets }, module);
  assert.ok(view);

  const quitPromise = view.waitForQuit();
  view.cleanup();

  await quitPromise;
});

test('DashboardProxy waitForQuit delegates to dashboard when present', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const { module } = makeFakeTextModule();

  const proxy = new DashboardProxy(stdout, {}, { stdout, selectedTickets: sampleTickets }, (opts) =>
    createOpenTuiDashboard(opts, module),
  );

  await proxy.start();

  const dashboard = (proxy as unknown as { dashboard: LiveRunView | null }).dashboard;
  assert.ok(dashboard);

  const quitPromise = proxy.waitForQuit();
  let resolved = false;
  quitPromise.then(() => {
    resolved = true;
  });

  proxy.done();

  await quitPromise;
  assert.equal(resolved, true);
});

test('DashboardProxy waitForQuit waits for dashboard startup before delegating', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  let resolveCreate!: () => void;
  let resolveQuit!: () => void;
  const createGate = new Promise<void>((resolve) => {
    resolveCreate = resolve;
  });
  const quitGate = new Promise<void>((resolve) => {
    resolveQuit = resolve;
  });
  const dashboard: LiveRunView = {
    update() {},
    done() {
      resolveQuit();
    },
    cleanup() {
      resolveQuit();
    },
    waitForQuit() {
      return quitGate;
    },
    killRequested() {
      return false;
    },
  };

  const proxy = new DashboardProxy(stdout, {}, { stdout, selectedTickets: sampleTickets }, async () => {
    await createGate;
    return dashboard;
  });

  const startPromise = proxy.start();
  const quitPromise = proxy.waitForQuit();
  let resolved = false;
  quitPromise.then(() => {
    resolved = true;
  });

  await Promise.resolve();
  assert.equal(resolved, false);

  resolveCreate();
  await startPromise;
  await Promise.resolve();
  assert.equal(resolved, false);

  resolveQuit();
  await quitPromise;
  assert.equal(resolved, true);
});

test('DashboardProxy waitForQuit resolves immediately for fallback', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);

  const proxy = new DashboardProxy(stdout, {}, { stdout }, async () => null);

  proxy.update({ ticketLabel: 'feat-a/001', message: 'starting' });
  await proxy.start();

  // Fallback is a progress line, waitForQuit should resolve immediately
  const quitPromise = proxy.waitForQuit();
  await quitPromise;
});

test('first k press arms kill and updates footer', async () => {
  const stdout = fakeStdout(true);
  const { module } = makeFakeTextModule();

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: sampleTickets }, module);
  assert.ok(view);

  const handled = (view as unknown as { handleKey(sequence: string): boolean }).handleKey('k');
  assert.equal(handled, true);
  assert.equal((view as unknown as { killRequested(): boolean }).killRequested(), false);

  view?.done();
});

test('second k press within timeout confirms kill', async () => {
  const stdout = fakeStdout(true);
  const { module } = makeFakeTextModule();

  const view = await createOpenTuiDashboard({ stdout, selectedTickets: sampleTickets }, module);
  assert.ok(view);

  (view as unknown as { handleKey(sequence: string): boolean }).handleKey('k');
  const handled = (view as unknown as { handleKey(sequence: string): boolean }).handleKey('k');
  assert.equal(handled, true);
  assert.equal((view as unknown as { killRequested(): boolean }).killRequested(), true);

  view?.done();
});

test('missing second k press disarms automatically after timeout', async () => {
  const origSetTimeout = global.setTimeout;
  const timeouts: Array<{ callback: () => void; delay: number }> = [];

  global.setTimeout = ((callback: () => void, delay: number) => {
    timeouts.push({ callback, delay });
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof global.setTimeout;

  try {
    const stdout = fakeStdout(true);
    const { module } = makeFakeTextModule();

    const view = await createOpenTuiDashboard({ stdout, selectedTickets: sampleTickets }, module);
    assert.ok(view);

    (view as unknown as { handleKey(sequence: string): boolean }).handleKey('k');
    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0]?.delay, 2000);

    // Simulate timeout firing
    timeouts[0]?.callback();

    assert.equal((view as unknown as { killRequested(): boolean }).killRequested(), false);

    view?.done();
  } finally {
    global.setTimeout = origSetTimeout;
  }
});

test('DashboardProxy killRequested delegates to dashboard', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const { module } = makeFakeTextModule();

  const proxy = new DashboardProxy(stdout, {}, { stdout, selectedTickets: sampleTickets }, (opts) =>
    createOpenTuiDashboard(opts, module),
  );

  await proxy.start();
  assert.equal(proxy.killRequested(), false);

  const dashboard = (proxy as unknown as { dashboard: LiveRunView | null }).dashboard;
  assert.ok(dashboard);

  (dashboard as unknown as { handleKey(sequence: string): boolean }).handleKey('k');
  (dashboard as unknown as { handleKey(sequence: string): boolean }).handleKey('k');

  assert.equal(proxy.killRequested(), true);

  proxy.done();
});
