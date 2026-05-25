import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CliRenderer, TextRenderable } from '@opentui/core';
import type { LiveRunView } from '../src/live-run-view.js';
import { createLiveRunView } from '../src/live-run-view.js';
import { createOpenTuiDashboard, DashboardProxy, type OpenTuiDashboardModule } from '../src/opentui-dashboard.js';
import type { TicketRecord } from '../src/types.js';

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
        this._content = String(value);
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
        this._content = String(value);
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

  const featuresBox = boxes.find((b) => b.title === 'Features');
  assert.ok(featuresBox, 'Features box should exist');
  const featuresContent = featuresBox.children.map((c) => c.content).join('\n');
  assert.match(featuresContent, /feat-a/);
  assert.match(featuresContent, /feat-b/);
  assert.match(featuresContent, /COMPLETE/);

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
        this._content = String(value);
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
        this._content = String(value);
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

  view?.update({ ticketLabel: 'feat-a/001', message: 'starting ticket run', sessionId: 'sess-1' });

  const detailsBox = boxes.find((b) => b.title === 'Details');
  assert.ok(detailsBox, 'Details box should exist');
  const detailsContent = detailsBox.children.map((c) => c.content).join('\n');
  assert.match(detailsContent, /feat-a\/001/);
  assert.match(detailsContent, /RUNNING/);
  assert.match(detailsContent, /sess-1/);

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
        this._content = String(value);
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
        this._content = String(value);
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

  const ticketsBox = boxes.find((b) => b.title === 'Tickets');
  assert.ok(ticketsBox, 'Tickets box should exist');
  const ticketsContent = ticketsBox.children.map((c) => c.content).join('\n');
  assert.match(ticketsContent, /> feat-a\/001/);
  assert.match(ticketsContent, / {2}feat-a\/002/);

  view?.done();
});
