import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildCodexThreadOptions,
  CodexSessionExecutor,
  discoverCodexModels,
  parseCodexApprovalPolicy,
  parseCodexBoolean,
  parseCodexModel,
  parseCodexSandboxMode,
} from '../src/codex.js';

class FakeCodexThread {
  runInputs: string[] = [];

  constructor(
    readonly id: string | null,
    private readonly events: Array<Record<string, unknown>> = [],
    private readonly failure?: Error,
  ) {}

  async runStreamed(input: string): Promise<{ events: AsyncIterable<Record<string, unknown>> }> {
    this.runInputs.push(input);
    if (this.failure) throw this.failure;
    return { events: this.streamEvents() };
  }

  private async *streamEvents(): AsyncGenerator<Record<string, unknown>> {
    for (const event of this.events) yield event;
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
    assert.deepEqual(client.resumed.map((entry) => entry.id), ['thread-existing']);
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
});
