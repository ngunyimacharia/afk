import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAfkOpencodeWith,
  extractModelsFromProvidersPayload,
  extractSessionOutput,
  extractSessionOutputLines,
  formatOpenCodeEvent,
  parseOpenCodeEvent,
  SDKOpenCodeSessionExecutor,
} from '../src/opencode.js';

test('extracts models when provider models are object maps', () => {
  const models = extractModelsFromProvidersPayload({
    providers: [
      {
        id: 'opencode',
        models: {
          'big-pickle': { id: 'big-pickle', name: 'Big Pickle' },
          'deepseek-v4-flash-free': { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free' },
        },
      },
      {
        id: 'opencode-go',
        models: {
          'glm-5': { id: 'glm-5', name: 'GLM 5' },
        },
      },
    ],
  });

  assert.deepEqual(
    models.map((model) => model.id),
    ['opencode/big-pickle', 'opencode/deepseek-v4-flash-free', 'opencode-go/glm-5'],
  );
});

test('extracts durable session output from assistant message errors and text parts', () => {
  const output = extractSessionOutputLines([
    {
      info: {
        role: 'assistant',
        error: {
          name: 'APIError',
          data: { message: 'The requested model is not available for integrator "copilot-language-server".' },
        },
      },
      parts: [
        { type: 'text', text: 'First line\nSecond line' },
        { type: 'tool', state: { status: 'error', error: 'command failed' } },
      ],
    },
  ]);

  assert.deepEqual(output, [
    'opencode error: The requested model is not available for integrator "copilot-language-server".',
    'First line',
    'Second line',
    'tool failed: command failed',
  ]);
});

test('extracts terminal session errors separately from tool failures', () => {
  const output = extractSessionOutput([
    {
      info: { error: { name: 'APIError', data: { message: 'Provider unavailable' } } },
      parts: [{ type: 'tool', state: { status: 'error', error: 'File not found' } }],
    },
  ]);

  assert.equal(output.terminalError, 'opencode error: Provider unavailable');
  assert.equal(output.finalMessageText, null);
  assert.deepEqual(output.lines, ['opencode error: Provider unavailable', 'tool failed: File not found']);
});

test('ignores recovered historical aborts when later assistant turn succeeds', () => {
  const output = extractSessionOutput([
    {
      role: 'assistant',
      error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
      parts: [{ type: 'text', text: 'stale attempt aborted' }],
    },
    {
      role: 'assistant',
      parts: [{ type: 'text', text: 'Recovered and completed' }],
    },
  ]);

  assert.equal(output.terminalError, null);
  assert.equal(output.finalMessageText, 'Recovered and completed');
  assert.deepEqual(output.lines, ['opencode error: Aborted', 'stale attempt aborted', 'Recovered and completed']);
});

test('uses only the final assistant turn for terminal session errors', () => {
  const output = extractSessionOutput([
    {
      role: 'assistant',
      error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
      parts: [{ type: 'text', text: 'earlier aborted turn' }],
    },
    {
      role: 'assistant',
      error: { name: 'APIError', data: { message: 'Provider unavailable' } },
      parts: [{ type: 'text', text: 'final failed turn' }],
    },
  ]);

  assert.equal(output.terminalError, 'opencode error: Provider unavailable');
  assert.equal(output.finalMessageText, 'final failed turn');
  assert.deepEqual(output.lines, [
    'opencode error: Aborted',
    'earlier aborted turn',
    'opencode error: Provider unavailable',
    'final failed turn',
  ]);
});

test('extracts reviewer text from alternate message shapes', () => {
  assert.deepEqual(
    extractSessionOutput({
      messages: [
        { content: '{"summary":"ok","findings":[]}' },
        { parts: [{ type: 'text', content: '{"summary":"part ok","findings":[]}' }] },
      ],
    }).lines,
    ['{"summary":"ok","findings":[]}', '{"summary":"part ok","findings":[]}'],
  );
});

test('extracts session output when messages are wrapped in an object payload', () => {
  const output = extractSessionOutputLines({
    messages: [
      {
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: 'Wrapped response line' }],
      },
    ],
  });

  assert.deepEqual(output, ['Wrapped response line']);
});

test('extracts session output when messages are nested under payload keys', () => {
  const output = extractSessionOutputLines({
    data: {
      items: [
        {
          parts: [{ type: 'text', text: 'Nested response line' }],
        },
      ],
    },
  });

  assert.deepEqual(output, ['Nested response line']);
});

test('deduplicates lines keeping last occurrence so assistant response is not shadowed by prompt examples', () => {
  const output = extractSessionOutputLines([
    {
      role: 'user',
      parts: [
        {
          type: 'text',
          text: [
            'Clean pass example:',
            '{"done":true,"summary":"Reviewed implementation and tests.","findings":[]}',
            'If ticket is incomplete, output:',
            '{"done":false,"summary":"Ticket incomplete","findings":[]}',
          ].join('\n'),
        },
      ],
    },
    {
      role: 'assistant',
      parts: [
        {
          type: 'text',
          text: '{"done":true,"summary":"Reviewed implementation and tests.","findings":[]}',
        },
      ],
    },
  ]);

  assert.deepEqual(output, [
    'Clean pass example:',
    'If ticket is incomplete, output:',
    '{"done":false,"summary":"Ticket incomplete","findings":[]}',
    '{"done":true,"summary":"Reviewed implementation and tests.","findings":[]}',
  ]);
});

test('formats session-level opencode progress events from real event stream shape', () => {
  assert.equal(
    formatOpenCodeEvent(
      { type: 'session.status', properties: { sessionID: 'session-1', status: { type: 'busy' } } },
      'session-1',
    ),
    'opencode session busy',
  );
  assert.equal(
    formatOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }, 'session-1'),
    'opencode session idle',
  );
  assert.equal(
    formatOpenCodeEvent(
      {
        type: 'session.error',
        properties: { sessionID: 'session-1', error: { name: 'APIError', data: { message: 'Insufficient balance' } } },
      },
      'session-1',
    ),
    'opencode error: Insufficient balance',
  );
  assert.equal(
    formatOpenCodeEvent(
      {
        data: {
          type: 'session.status',
          properties: { sessionID: 'session-1', status: { type: 'retry', attempt: 2, message: 'rate limited' } },
        },
      },
      'session-1',
    ),
    'opencode retry 2: rate limited',
  );
});

test('ignores opencode progress events from unrelated sessions', () => {
  assert.equal(
    formatOpenCodeEvent(
      { type: 'session.status', properties: { sessionID: 'other-session', status: { type: 'busy' } } },
      'session-1',
    ),
    null,
  );
  assert.equal(
    formatOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: { part: { sessionID: 'other-session', type: 'text', text: 'not ours' } },
      },
      'session-1',
    ),
    null,
  );
});

test('formats opencode permission requests as permission progress events', () => {
  const event = parseOpenCodeEvent(
    {
      type: 'permission.updated',
      properties: {
        id: 'per_123',
        type: 'external_directory',
        pattern: ['/tmp/feat-one-worktree/*'],
        sessionID: 'session-1',
        title: 'Access external worktree',
      },
    },
    'session-1',
  );

  assert.equal(event?.kind, 'permission');
  assert.equal(event?.permissionId, 'per_123');
  assert.deepEqual(event?.permissionPatterns, ['/tmp/feat-one-worktree/*']);
  assert.equal(event?.permissionType, 'external_directory');
  assert.equal(event?.permissionTitle, 'Access external worktree');
  assert.match(event?.message ?? '', /external_directory/);
  assert.match(event?.message ?? '', /Access external worktree/);
  assert.match(event?.message ?? '', /\/tmp\/feat-one-worktree\/\*/);
});

test('formats opencode permission replies', () => {
  assert.equal(
    formatOpenCodeEvent(
      { type: 'permission.replied', properties: { sessionID: 'session-1', permissionID: 'per_123', response: 'once' } },
      'session-1',
    ),
    'opencode permission once (per_123)',
  );
});

test('sets OPENCODE_PURE before creating opencode sdk server', async () => {
  const previousPure = process.env.OPENCODE_PURE;
  try {
    process.env.OPENCODE_PURE = 'false';
    let observedPure: string | undefined;
    let observedPort: number | undefined;

    await createAfkOpencodeWith(async ({ port }) => {
      observedPure = process.env.OPENCODE_PURE;
      observedPort = port;
      return {} as Awaited<ReturnType<typeof createAfkOpencodeWith>>;
    });

    assert.equal(observedPure, 'true');
    assert.equal(observedPort, 0);
    assert.equal(process.env.OPENCODE_PURE, 'true');
  } finally {
    if (previousPure === undefined) {
      delete process.env.OPENCODE_PURE;
    } else {
      process.env.OPENCODE_PURE = previousPure;
    }
  }
});

test('recovers stale opencode prompts in the same session', async () => {
  const promptBodies: unknown[] = [];
  const promptPaths: string[] = [];
  let createCalls = 0;
  let abortCalls = 0;
  const executor = new SDKOpenCodeSessionExecutor(
    async () =>
      ({
        server: { url: 'http://127.0.0.1:1', close() {} },
        client: {
          session: {
            create: async () => {
              createCalls += 1;
              return { id: 'session-stale' };
            },
            prompt: async (options: { path: { id: string }; body: unknown }) => {
              promptPaths.push(options.path.id);
              promptBodies.push(options.body);
              if (promptBodies.length === 1) return new Promise(() => undefined);
              return { ok: true };
            },
            abort: async (options: { path: { id: string } }) => {
              assert.equal(options.path.id, 'session-stale');
              abortCalls += 1;
              return true;
            },
            messages: async () => [
              {
                role: 'assistant',
                error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
                parts: [{ type: 'text', text: 'stale attempt aborted' }],
              },
              {
                info: { role: 'assistant' },
                parts: [{ type: 'text', text: 'Recovered and completed' }],
              },
            ],
          },
        },
      }) as never,
  );
  const progress: string[] = [];

  const result = await executor.run({
    model: { id: 'openai/gpt-5.3-codex' },
    title: 'afk: feat/01',
    prompt: 'Original prompt',
    agent: 'build',
    staleProgressTimeoutMs: 5,
    onProgress: (event) => progress.push(event.message),
  });

  assert.equal(result.sessionId, 'session-stale');
  assert.equal(result.terminalError, null);
  assert.equal(result.finalMessageText, 'Recovered and completed');
  assert.deepEqual(result.output, ['opencode error: Aborted', 'stale attempt aborted', 'Recovered and completed']);
  assert.equal(createCalls, 1);
  assert.equal(abortCalls, 1);
  assert.deepEqual(promptPaths, ['session-stale', 'session-stale']);
  assert.match(JSON.stringify(promptBodies[1]), /Continue/);
  assert.match(progress.join('\n'), /opencode stale recovery attempt 1\/5/);
});

test('stops same-session stale recovery after configured cap', async () => {
  let abortCalls = 0;
  const promptPaths: string[] = [];
  const executor = new SDKOpenCodeSessionExecutor(
    async () =>
      ({
        server: { url: 'http://127.0.0.1:1', close() {} },
        client: {
          session: {
            create: async () => ({ id: 'session-stale-cap' }),
            prompt: async (options: { path: { id: string } }) => {
              promptPaths.push(options.path.id);
              return new Promise(() => undefined);
            },
            abort: async () => {
              abortCalls += 1;
              return true;
            },
            messages: async () => [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Partial work' }] }],
          },
        },
      }) as never,
  );

  const result = await executor.run({
    model: { id: 'openai/gpt-5.3-codex' },
    title: 'afk: feat/01',
    prompt: 'Original prompt',
    staleProgressTimeoutMs: 5,
    maxStaleRecoveries: 2,
  });

  assert.equal(result.sessionId, 'session-stale-cap');
  assert.equal(result.terminalError, 'opencode session stale after 2 recovery attempts');
  assert.deepEqual(result.output, ['Partial work']);
  assert.equal(abortCalls, 3);
  assert.deepEqual(promptPaths, ['session-stale-cap', 'session-stale-cap', 'session-stale-cap']);
});

test('does not mark a running opencode tool stale at the normal progress timeout', async () => {
  const executor = new SDKOpenCodeSessionExecutor(
    async () =>
      ({
        server: { url: 'http://127.0.0.1:1', close() {} },
        client: {
          event: {
            subscribe: async () => ({
              stream: oneEventAfterTick({
                type: 'message.part.updated',
                properties: {
                  part: {
                    sessionID: 'session-tool-running',
                    type: 'tool',
                    tool: 'bash',
                    state: { status: 'running', title: 'Runs slow tests' },
                  },
                },
              }),
            }),
          },
          session: {
            create: async () => ({ id: 'session-tool-running' }),
            prompt: async () => {
              await delay(30);
              return { ok: true };
            },
            abort: async () => assert.fail('running tool should not be aborted at the normal stale timeout'),
            messages: async () => [
              {
                role: 'assistant',
                parts: [{ type: 'text', text: 'Slow tests completed' }],
              },
            ],
          },
        },
      }) as never,
  );
  const progress: string[] = [];

  const result = await executor.run({
    model: { id: 'openai/gpt-5.3-codex' },
    title: 'afk: feat/01',
    prompt: 'Original prompt',
    staleProgressTimeoutMs: 5,
    activeToolStaleTimeoutMs: 100,
    onProgress: (event) => progress.push(event.message),
  });

  assert.equal(result.terminalError, null);
  assert.equal(result.finalMessageText, 'Slow tests completed');
  assert.match(progress.join('\n'), /tool bash running: Runs slow tests/);
  assert.doesNotMatch(progress.join('\n'), /opencode session stale after 5ms/);
});

test('marks a running opencode tool stale after the active tool timeout', async () => {
  let abortCalls = 0;
  const executor = new SDKOpenCodeSessionExecutor(
    async () =>
      ({
        server: { url: 'http://127.0.0.1:1', close() {} },
        client: {
          event: {
            subscribe: async () => ({
              stream: oneEventAfterTick({
                type: 'message.part.updated',
                properties: {
                  part: {
                    sessionID: 'session-tool-stale',
                    type: 'tool',
                    tool: 'bash',
                    state: { status: 'running', title: 'Runs hung tests' },
                  },
                },
              }),
            }),
          },
          session: {
            create: async () => ({ id: 'session-tool-stale' }),
            prompt: async () => new Promise(() => undefined),
            abort: async () => {
              abortCalls += 1;
              return true;
            },
            messages: async () => [{ role: 'assistant', parts: [{ type: 'text', text: 'Partial work' }] }],
          },
        },
      }) as never,
  );
  const progress: string[] = [];

  const result = await executor.run({
    model: { id: 'openai/gpt-5.3-codex' },
    title: 'afk: feat/01',
    prompt: 'Original prompt',
    staleProgressTimeoutMs: 5,
    activeToolStaleTimeoutMs: 25,
    maxStaleRecoveries: 0,
    onProgress: (event) => progress.push(event.message),
  });

  assert.equal(result.terminalError, 'opencode session stale after 0 recovery attempts');
  assert.equal(abortCalls, 1);
  assert.match(
    progress.join('\n'),
    /opencode tool stale after 25ms: tool bash running: Runs hung tests; interrupting session/,
  );
});

test('passes workDir as directory query to session create and prompt', async () => {
  const createArgs: unknown[] = [];
  const promptBodies: unknown[] = [];
  const executor = new SDKOpenCodeSessionExecutor(
    async () =>
      ({
        server: { url: 'http://127.0.0.1:1', close() {} },
        client: {
          session: {
            create: async (options: unknown) => {
              createArgs.push(options);
              return { id: 'session-workdir' };
            },
            prompt: async (options: { path: { id: string }; body: unknown }) => {
              promptBodies.push(options.body);
              return { ok: true };
            },
            messages: async () => [{ role: 'assistant', parts: [{ type: 'text', text: 'Done' }] }],
          },
        },
      }) as never,
  );

  const result = await executor.run({
    model: { id: 'openai/gpt-5.3-codex' },
    title: 'afk: feat/01',
    prompt: 'Implement feature',
    workDir: '/repo/.worktree/feat-01',
  });

  assert.equal(result.sessionId, 'session-workdir');
  assert.equal(result.terminalError, null);
  assert.equal(createArgs.length, 1);
  assert.deepEqual((createArgs[0] as { query?: { directory?: string } }).query, {
    directory: '/repo/.worktree/feat-01',
  });
  assert.equal(promptBodies.length, 1);
  assert.deepEqual((promptBodies[0] as { query?: { directory?: string } }).query, {
    directory: '/repo/.worktree/feat-01',
  });
});

test('omits directory query when workDir is undefined', async () => {
  const createArgs: unknown[] = [];
  const promptBodies: unknown[] = [];
  const executor = new SDKOpenCodeSessionExecutor(
    async () =>
      ({
        server: { url: 'http://127.0.0.1:1', close() {} },
        client: {
          session: {
            create: async (options: unknown) => {
              createArgs.push(options);
              return { id: 'session-no-workdir' };
            },
            prompt: async (options: { path: { id: string }; body: unknown }) => {
              promptBodies.push(options.body);
              return { ok: true };
            },
            messages: async () => [{ role: 'assistant', parts: [{ type: 'text', text: 'Done' }] }],
          },
        },
      }) as never,
  );

  const result = await executor.run({
    model: { id: 'openai/gpt-5.3-codex' },
    title: 'afk: feat/01',
    prompt: 'Implement feature',
  });

  assert.equal(result.sessionId, 'session-no-workdir');
  assert.equal(createArgs.length, 1);
  assert.equal((createArgs[0] as { query?: unknown }).query, undefined);
  assert.equal(promptBodies.length, 1);
  assert.equal((promptBodies[0] as { query?: unknown }).query, undefined);
});

async function* oneEventAfterTick(event: unknown): AsyncIterable<unknown> {
  await delay(0);
  yield event;
  await new Promise(() => undefined);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
