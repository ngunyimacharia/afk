import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildPiSessionOptions,
  discoverPiModels,
  PiSessionExecutor,
  parsePiEvent,
  parsePiModel,
  resolvePiToolAllowlist,
} from '../src/pi.js';

type FakePiEvent = Record<string, unknown> & { delayMs?: number; hang?: boolean };

class FakePiSession {
  runInputs: string[] = [];
  signals: AbortSignal[] = [];

  constructor(
    readonly id: string | null,
    private readonly events: FakePiEvent[] | FakePiEvent[][] = [],
    private readonly failure?: Error,
  ) {}

  async run(input: {
    prompt: string;
    signal?: AbortSignal;
  }): Promise<{ events: AsyncIterable<Record<string, unknown>> }> {
    this.runInputs.push(input.prompt);
    if (input.signal) this.signals.push(input.signal);
    if (this.failure) throw this.failure;
    return { events: this.streamEvents(this.eventsForRun(), input.signal) };
  }

  private eventsForRun(): FakePiEvent[] {
    if (!this.events.length) return [];
    if (Array.isArray(this.events[0])) {
      const runs = this.events as FakePiEvent[][];
      return runs[Math.min(this.runInputs.length - 1, runs.length - 1)] ?? [];
    }
    return this.events as FakePiEvent[];
  }

  private async *streamEvents(events: FakePiEvent[], signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
    for (const event of events) {
      if (event.delayMs) await sleep(event.delayMs);
      if (event.hang) await waitForAbort(signal);
      if (signal?.aborted) return;
      const { delayMs: _delayMs, hang: _hang, ...payload } = event;
      yield payload;
    }
  }
}

class FakePiClient {
  startedOptions: unknown[] = [];
  resumed: Array<{ id: string; options: unknown }> = [];
  startSessionResult: FakePiSession;
  resumeSessionResult: FakePiSession;

  constructor(options: { startSession?: FakePiSession; resumeSession?: FakePiSession } = {}) {
    this.startSessionResult = options.startSession ?? new FakePiSession('session-new');
    this.resumeSessionResult = options.resumeSession ?? new FakePiSession('session-existing');
  }

  startSession(options?: unknown): FakePiSession {
    this.startedOptions.push(options);
    return this.startSessionResult;
  }

  resumeSession(id: string, options?: unknown): FakePiSession {
    this.resumed.push({ id, options });
    return this.resumeSessionResult;
  }
}

describe('PiSessionExecutor', () => {
  test('discovers default and configured PI launch models', async () => {
    const models = await discoverPiModels({ AFK_PI_MODELS: 'openai/gpt-5.1, anthropic/claude-opus' });

    assert.deepEqual(
      models.map((model) => model.id),
      ['pi/default', 'pi/openai/gpt-5.1', 'pi/anthropic/claude-opus'],
    );
  });

  test('parses pi/default without an explicit model option', () => {
    assert.equal(parsePiModel('pi/default'), null);
    const options = buildPiSessionOptions({ id: 'pi/default' }, '/repo/worktree', 'afk: feat/01', 'execution');
    assert.equal(options.model, undefined);
    assert.equal(options.workingDirectory, '/repo/worktree');
    assert.deepEqual(options.toolAllowlist, resolvePiToolAllowlist('execution'));
  });

  test('parses provider/model PI ids and forwards them to the session options', () => {
    assert.equal(parsePiModel('pi/openai/gpt-5.1'), 'openai/gpt-5.1');
    const options = buildPiSessionOptions({ id: 'pi/openai/gpt-5.1' }, '/repo/worktree');
    assert.equal(options.model, 'openai/gpt-5.1');
  });

  test('restricts tool allowlists by invocation mode', () => {
    assert.ok(resolvePiToolAllowlist('execution').includes('write'));
    assert.ok(!resolvePiToolAllowlist('reviewer').includes('write'));
    assert.ok(resolvePiToolAllowlist('reviewer').includes('read'));
    assert.ok(!resolvePiToolAllowlist('pull-request').includes('write'));
    assert.ok(resolvePiToolAllowlist('pull-request').includes('github-pr'));
  });

  test('starts a new PI session and returns the session id from the stream', async () => {
    const client = new FakePiClient({
      startSession: new FakePiSession('session-late', [
        { type: 'session.started', session_id: 'session-started' },
        { type: 'turn.completed' },
      ]),
    });
    const executor = new PiSessionExecutor('execution', () => client);

    const result = await executor.run({
      model: { id: 'pi/default' },
      prompt: 'do work',
      title: 'afk: feat/01',
    });

    assert.equal(client.startedOptions.length, 1);
    assert.equal(client.resumed.length, 0);
    assert.equal(result.sessionId, 'session-started');
    assert.equal(result.terminalError, null);
  });

  test('resumes an existing PI session when session id is provided', async () => {
    const client = new FakePiClient({
      resumeSession: new FakePiSession('session-existing', [{ type: 'turn.completed' }]),
    });
    const executor = new PiSessionExecutor('execution', () => client);

    const result = await executor.run({
      model: { id: 'pi/openai/gpt-5.1' },
      prompt: 'continue work',
      title: 'afk: feat/01',
      sessionId: 'session-existing',
    });

    assert.equal(client.startedOptions.length, 0);
    assert.deepEqual(
      client.resumed.map((entry) => entry.id),
      ['session-existing'],
    );
    assert.equal(result.sessionId, 'session-existing');
  });

  test('returns final PI assistant message text in output fields', async () => {
    const client = new FakePiClient({
      startSession: new FakePiSession('session-output', [
        { type: 'session.started', session_id: 'session-output' },
        { type: 'message', role: 'assistant', content: 'first response' },
        { type: 'message', role: 'assistant', content: 'final response' },
        { type: 'turn.completed' },
      ]),
    });
    const executor = new PiSessionExecutor('execution', () => client);

    const result = await executor.run({ model: { id: 'pi/default' }, prompt: 'run', title: 'afk: feat/01' });

    assert.deepEqual(result.output, ['first response', 'final response']);
    assert.equal(result.finalMessageText, 'final response');
  });

  test('returns terminal errors for SDK and turn failures', async () => {
    const sdkFailure = new PiSessionExecutor(
      'execution',
      () => new FakePiClient({ startSession: new FakePiSession('session-fail', [], new Error('pi sdk exploded')) }),
    );
    const sdkResult = await sdkFailure.run({ model: { id: 'pi/default' }, prompt: 'run', title: 'afk: feat/01' });
    assert.equal(sdkResult.terminalError, 'pi sdk exploded');

    const turnFailure = new PiSessionExecutor(
      'execution',
      () =>
        new FakePiClient({
          startSession: new FakePiSession('session-turn', [
            { type: 'session.started', session_id: 'session-turn' },
            { type: 'turn.failed', error: { message: 'turn failed' } },
          ]),
        }),
    );
    const turnResult = await turnFailure.run({ model: { id: 'pi/default' }, prompt: 'run', title: 'afk: feat/01' });
    assert.equal(turnResult.sessionId, 'session-turn');
    assert.equal(turnResult.terminalError, 'turn failed');
  });

  test('maps PI stream events into AFK progress messages', () => {
    const events = [
      parsePiEvent({ type: 'session.started', session_id: 'session-progress' }, null),
      parsePiEvent({ type: 'turn.started' }, 'session-progress'),
      parsePiEvent({ type: 'tool_call', name: 'bash', status: 'running', arguments: 'bun test' }, 'session-progress'),
      parsePiEvent({ type: 'file_change', path: 'src/app.ts', action: 'updated' }, 'session-progress'),
      parsePiEvent({ type: 'message', role: 'assistant', content: 'done' }, 'session-progress'),
      parsePiEvent({ type: 'turn.completed' }, 'session-progress'),
    ];

    assert.deepEqual(
      events.map((event) => event?.message),
      [
        'created pi session session-progress',
        'pi turn started',
        'tool bash running: bun test',
        'file updated: src/app.ts',
        'done',
        'pi turn completed',
      ],
    );
    assert.equal(events[2]?.activity, 'tool');
    assert.equal(events[3]?.activity, 'diff');
  });

  test('aborts a stale PI turn and recovers in the same session', async () => {
    const session = new FakePiSession('session-stale', [
      [{ type: 'session.started', session_id: 'session-stale' }, { hang: true }],
      [{ type: 'message', role: 'assistant', content: 'recovered' }, { type: 'turn.completed' }],
    ]);
    const client = new FakePiClient({ startSession: session });
    const progress: string[] = [];
    const executor = new PiSessionExecutor('execution', () => client);

    const result = await executor.run({
      model: { id: 'pi/default' },
      prompt: 'run',
      title: 'afk: feat/01',
      staleProgressTimeoutMs: 5,
      maxStaleRecoveries: 1,
      onProgress: (event) => progress.push(event.message),
    });

    assert.equal(client.startedOptions.length, 1);
    assert.equal(client.resumed.length, 0);
    assert.equal(session.signals[0]?.aborted, true);
    assert.deepEqual(session.runInputs, [
      'run',
      'Continue (stale recovery attempt 1/1). Verify whether the active tool is still making progress, or report a blocker and stop.',
    ]);
    assert.equal(result.sessionId, 'session-stale');
    assert.equal(result.terminalError, null);
    assert.equal(result.finalMessageText, 'recovered');
    assert.match(progress.join('\n'), /pi stale recovery attempt 1\/1/);
  });

  test('stops after the configured PI stale recovery cap', async () => {
    const session = new FakePiSession('session-cap', [
      [{ type: 'session.started', session_id: 'session-cap' }, { hang: true }],
      [{ hang: true }],
    ]);
    const executor = new PiSessionExecutor('execution', () => new FakePiClient({ startSession: session }));

    const result = await executor.run({
      model: { id: 'pi/default' },
      prompt: 'run',
      title: 'afk: feat/01',
      staleProgressTimeoutMs: 5,
      maxStaleRecoveries: 1,
    });

    assert.deepEqual(session.runInputs, [
      'run',
      'Continue (stale recovery attempt 1/1). Verify whether the active tool is still making progress, or report a blocker and stop.',
    ]);
    assert.equal(result.terminalError, 'pi session stale after 1 recovery attempts');
  });

  test('AFK kill aborts the active PI turn', async () => {
    const session = new FakePiSession('session-kill', [
      { type: 'session.started', session_id: 'session-kill' },
      { hang: true },
    ]);
    const controller = new AbortController();
    const executor = new PiSessionExecutor('execution', () => new FakePiClient({ startSession: session }));
    const run = executor.run({
      model: { id: 'pi/default' },
      prompt: 'run',
      title: 'afk: feat/01',
      staleProgressTimeoutMs: 1_000,
      signal: controller.signal,
    });

    await sleep(5);
    controller.abort();
    const result = await run;

    assert.equal(session.signals[0]?.aborted, true);
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
