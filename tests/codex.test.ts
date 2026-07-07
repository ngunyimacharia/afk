import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildCodexThreadOptions,
  CodexSessionExecutor,
  discoverCodexModels,
  parseCodexApprovalPolicy,
  parseCodexBoolean,
  parseCodexEvent,
  parseCodexModel,
  parseCodexSandboxMode,
} from '../src/codex.js';

type FakeCodexEvent = Record<string, unknown> & { delayMs?: number; hang?: boolean };

class FakeCodexThread {
  runInputs: string[] = [];
  signals: AbortSignal[] = [];

  constructor(
    readonly id: string | null,
    private readonly events: FakeCodexEvent[] | FakeCodexEvent[][] = [],
    private readonly failure?: Error,
  ) {}

  async runStreamed(
    input: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncIterable<Record<string, unknown>> }> {
    this.runInputs.push(input);
    if (options?.signal) this.signals.push(options.signal);
    if (this.failure) throw this.failure;
    return { events: this.streamEvents(this.eventsForRun(), options?.signal) };
  }

  private eventsForRun(): FakeCodexEvent[] {
    if (!this.events.length) return [];
    if (Array.isArray(this.events[0])) {
      const runs = this.events as FakeCodexEvent[][];
      return runs[Math.min(this.runInputs.length - 1, runs.length - 1)] ?? [];
    }
    return this.events as FakeCodexEvent[];
  }

  private async *streamEvents(events: FakeCodexEvent[], signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
    for (const event of events) {
      if (event.delayMs) await sleep(event.delayMs);
      if (event.hang) await waitForAbort(signal);
      if (signal?.aborted) return;
      const { delayMs: _delayMs, hang: _hang, ...payload } = event;
      yield payload;
    }
  }
}

class FakeCodexClient {
  startedOptions: unknown[] = [];
  resumed: Array<{ id: string; options: unknown }> = [];
  startThreadResult: FakeCodexThread;
  resumeThreadResult: FakeCodexThread;

  constructor(options: { startThread?: FakeCodexThread; resumeThread?: FakeCodexThread } = {}) {
    this.startThreadResult = options.startThread ?? new FakeCodexThread('thread-new');
    this.resumeThreadResult = options.resumeThread ?? new FakeCodexThread('thread-existing');
  }

  startThread(options?: unknown): FakeCodexThread {
    this.startedOptions.push(options);
    return this.startThreadResult;
  }

  resumeThread(id: string, options?: unknown): FakeCodexThread {
    this.resumed.push({ id, options });
    return this.resumeThreadResult;
  }
}

describe('CodexSessionExecutor', () => {
  test('discovers default and configured Codex launch models', async () => {
    const models = await discoverCodexModels({ AFK_CODEX_MODELS: 'gpt-x, gpt-y' });

    assert.deepEqual(
      models.map((model) => model.id),
      ['codex/default', 'codex/gpt-x', 'codex/gpt-y'],
    );
  });

  test('starts a new Codex thread and returns the thread id from the stream', async () => {
    const client = new FakeCodexClient({
      startThread: new FakeCodexThread('thread-late', [
        { type: 'thread.started', thread_id: 'thread-started' },
        { type: 'turn.completed', usage: null },
      ]),
    });
    const executor = new CodexSessionExecutor(() => client);

    const result = await executor.run({
      model: { id: 'codex/default' },
      prompt: 'do work',
      title: 'afk: feat/01',
    });

    assert.equal(client.startedOptions.length, 1);
    assert.equal(client.resumed.length, 0);
    assert.equal(result.sessionId, 'thread-started');
    assert.equal(result.terminalError, null);
  });

  test('resumes an existing Codex thread when session id is provided', async () => {
    const client = new FakeCodexClient({
      resumeThread: new FakeCodexThread('thread-existing', [{ type: 'turn.completed', usage: null }]),
    });
    const executor = new CodexSessionExecutor(() => client);

    const result = await executor.run({
      model: { id: 'codex/some-model' },
      prompt: 'continue work',
      title: 'afk: feat/01',
      sessionId: 'thread-existing',
    });

    assert.equal(client.startedOptions.length, 0);
    assert.deepEqual(
      client.resumed.map((entry) => entry.id),
      ['thread-existing'],
    );
    assert.equal(result.sessionId, 'thread-existing');
  });

  test('parses codex/default without an explicit model option', () => {
    assert.equal(parseCodexModel('codex/default'), null);
    assert.deepEqual(buildCodexThreadOptions({ id: 'codex/default' }, '/repo/worktree', {}), {
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      sandboxMode: 'workspace-write',
      workingDirectory: '/repo/worktree',
    });
  });

  test('parses codex model suffix and forwards workdir', () => {
    assert.equal(parseCodexModel('codex/some-model'), 'some-model');
    assert.deepEqual(buildCodexThreadOptions({ id: 'codex/some-model' }, '/repo/worktree', {}), {
      approvalPolicy: 'never',
      model: 'some-model',
      networkAccessEnabled: false,
      sandboxMode: 'workspace-write',
      workingDirectory: '/repo/worktree',
    });
  });

  test('uses explicit Codex sandbox override ahead of environment defaults', () => {
    assert.deepEqual(
      buildCodexThreadOptions(
        { id: 'codex/default' },
        '/repo/worktree',
        { AFK_CODEX_SANDBOX: 'read-only' },
        'danger-full-access',
      ),
      {
        approvalPolicy: 'never',
        networkAccessEnabled: false,
        sandboxMode: 'danger-full-access',
        workingDirectory: '/repo/worktree',
      },
    );
  });

  test('parses Codex environment overrides and falls back on invalid values', () => {
    assert.equal(parseCodexSandboxMode('danger-full-access'), 'danger-full-access');
    assert.equal(parseCodexSandboxMode('invalid'), 'workspace-write');
    assert.equal(parseCodexApprovalPolicy('on-request'), 'on-request');
    assert.equal(parseCodexApprovalPolicy('prompt-me'), 'never');
    assert.equal(parseCodexBoolean('yes'), true);
    assert.equal(parseCodexBoolean('maybe'), false);

    assert.deepEqual(
      buildCodexThreadOptions({ id: 'codex/gpt-5.1-codex' }, '/repo/worktree', {
        AFK_CODEX_APPROVAL: 'on-failure',
        AFK_CODEX_NETWORK: 'true',
        AFK_CODEX_SANDBOX: 'read-only',
      }),
      {
        approvalPolicy: 'on-failure',
        model: 'gpt-5.1-codex',
        networkAccessEnabled: true,
        sandboxMode: 'read-only',
        workingDirectory: '/repo/worktree',
      },
    );
  });

  test('returns final Codex agent message text in output fields', async () => {
    const client = new FakeCodexClient({
      startThread: new FakeCodexThread('thread-output', [
        { type: 'thread.started', thread_id: 'thread-output' },
        { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'first response' } },
        { type: 'item.completed', item: { id: 'msg-2', type: 'agent_message', text: 'final response' } },
        { type: 'turn.completed', usage: null },
      ]),
    });
    const executor = new CodexSessionExecutor(() => client);

    const result = await executor.run({ model: { id: 'codex/default' }, prompt: 'run', title: 'afk: feat/01' });

    assert.deepEqual(result.output, ['first response', 'final response']);
    assert.equal(result.finalMessageText, 'final response');
  });

  test('returns terminal errors for SDK and turn failures', async () => {
    const sdkFailure = new CodexSessionExecutor(
      () => new FakeCodexClient({ startThread: new FakeCodexThread('thread-fail', [], new Error('sdk exploded')) }),
    );
    const sdkResult = await sdkFailure.run({ model: { id: 'codex/default' }, prompt: 'run', title: 'afk: feat/01' });
    assert.equal(sdkResult.terminalError, 'sdk exploded');

    const turnFailure = new CodexSessionExecutor(
      () =>
        new FakeCodexClient({
          startThread: new FakeCodexThread('thread-turn', [
            { type: 'thread.started', thread_id: 'thread-turn' },
            { type: 'turn.failed', error: { message: 'turn failed' } },
          ]),
        }),
    );
    const turnResult = await turnFailure.run({ model: { id: 'codex/default' }, prompt: 'run', title: 'afk: feat/01' });
    assert.equal(turnResult.sessionId, 'thread-turn');
    assert.equal(turnResult.terminalError, 'turn failed');
  });

  test('maps Codex stream events into AFK progress messages', () => {
    const events = [
      parseCodexEvent({ type: 'thread.started', thread_id: 'thread-progress' }, null),
      parseCodexEvent({ type: 'turn.started' }, 'thread-progress'),
      parseCodexEvent(
        { type: 'item.updated', item: { type: 'command_execution', command: 'bun test', status: 'running' } },
        'thread-progress',
      ),
      parseCodexEvent(
        { type: 'item.completed', item: { type: 'file_change', path: 'src/app.ts', action: 'updated' } },
        'thread-progress',
      ),
      parseCodexEvent(
        { type: 'item.updated', item: { type: 'mcp_tool_call', name: 'context7', status: 'running' } },
        'thread-progress',
      ),
      parseCodexEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }, 'thread-progress'),
      parseCodexEvent({ type: 'turn.completed' }, 'thread-progress'),
    ];

    assert.deepEqual(
      events.map((event) => event?.message),
      [
        'created codex thread thread-progress',
        'codex turn started',
        'tool bash running: bun test',
        'file updated: src/app.ts',
        'tool context7 running',
        'done',
        'codex turn completed',
      ],
    );
    assert.equal(events[2]?.activity, 'tool');
    assert.equal(events[3]?.activity, 'diff');
  });

  test('aborts a stale Codex turn and recovers in the same thread', async () => {
    const thread = new FakeCodexThread('thread-stale', [
      [{ type: 'thread.started', thread_id: 'thread-stale' }, { hang: true }],
      [
        { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'recovered' } },
        { type: 'turn.completed' },
      ],
    ]);
    const client = new FakeCodexClient({ startThread: thread });
    const progress: string[] = [];
    const executor = new CodexSessionExecutor(() => client);

    const result = await executor.run({
      model: { id: 'codex/default' },
      prompt: 'run',
      title: 'afk: feat/01',
      staleProgressTimeoutMs: 5,
      maxStaleRecoveries: 1,
      onProgress: (event) => progress.push(event.message),
    });

    assert.equal(client.startedOptions.length, 1);
    assert.equal(client.resumed.length, 0);
    assert.equal(thread.signals[0]?.aborted, true);
    assert.deepEqual(thread.runInputs, [
      'run',
      'Continue (stale recovery attempt 1/1). Verify whether the active tool is still making progress, or report a blocker and stop.',
    ]);
    assert.equal(result.sessionId, 'thread-stale');
    assert.equal(result.terminalError, null);
    assert.equal(result.finalMessageText, 'recovered');
    assert.match(progress.join('\n'), /codex stale recovery attempt 1\/1/);
  });

  test('stops after the configured Codex stale recovery cap', async () => {
    const thread = new FakeCodexThread('thread-cap', [
      [{ type: 'thread.started', thread_id: 'thread-cap' }, { hang: true }],
      [{ hang: true }],
    ]);
    const executor = new CodexSessionExecutor(() => new FakeCodexClient({ startThread: thread }));

    const result = await executor.run({
      model: { id: 'codex/default' },
      prompt: 'run',
      title: 'afk: feat/01',
      staleProgressTimeoutMs: 5,
      maxStaleRecoveries: 1,
    });

    assert.deepEqual(thread.runInputs, [
      'run',
      'Continue (stale recovery attempt 1/1). Verify whether the active tool is still making progress, or report a blocker and stop.',
    ]);
    assert.equal(result.terminalError, 'codex session stale after 1 recovery attempts');
  });

  test('uses the active-tool stale timeout while a Codex command is running', async () => {
    const thread = new FakeCodexThread('thread-tool', [
      { type: 'thread.started', thread_id: 'thread-tool' },
      { type: 'item.updated', item: { type: 'command_execution', command: 'sleep 60', status: 'running' } },
      { hang: true },
    ]);
    const controller = new AbortController();
    const executor = new CodexSessionExecutor(() => new FakeCodexClient({ startThread: thread }));
    const run = executor.run({
      model: { id: 'codex/default' },
      prompt: 'run',
      title: 'afk: feat/01',
      staleProgressTimeoutMs: 5,
      activeToolStaleTimeoutMs: 50,
      maxStaleRecoveries: 0,
      signal: controller.signal,
    });

    await sleep(20);
    assert.equal(thread.signals[0]?.aborted, false);
    controller.abort();
    const result = await run;
    assert.equal(result.terminalError, 'run killed');
  });

  test('AFK kill aborts the active Codex turn', async () => {
    const thread = new FakeCodexThread('thread-kill', [
      { type: 'thread.started', thread_id: 'thread-kill' },
      { hang: true },
    ]);
    const controller = new AbortController();
    const executor = new CodexSessionExecutor(() => new FakeCodexClient({ startThread: thread }));
    const run = executor.run({
      model: { id: 'codex/default' },
      prompt: 'run',
      title: 'afk: feat/01',
      staleProgressTimeoutMs: 1_000,
      signal: controller.signal,
    });

    await sleep(5);
    controller.abort();
    const result = await run;

    assert.equal(thread.signals[0]?.aborted, true);
    assert.equal(result.terminalError, 'run killed');
  });

  test('pre-aborted signal stops Codex before starting a turn', async () => {
    const client = new FakeCodexClient({
      startThread: new FakeCodexThread('thread-preabort', [{ hang: true }]),
    });
    const controller = new AbortController();
    controller.abort();
    const executor = new CodexSessionExecutor(() => client);

    const result = await executor.run({
      model: { id: 'codex/default' },
      prompt: 'run',
      title: 'afk: feat/01',
      signal: controller.signal,
    });

    assert.equal(client.startedOptions.length, 1);
    assert.deepEqual(client.startedOptions[0], {
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      sandboxMode: 'workspace-write',
    });
    assert.equal(result.terminalError, 'run killed');
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForAbort(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });
}
