import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KimiAgentExecutionProvider } from '../src/agent-execution-provider.js';
import { KimiSessionExecutor } from '../src/kimi.js';

test('kimi provider maps successful execution to completed result', async () => {
  let capturedAgent = '';
  let capturedTitle = '';
  let capturedWorkDir: string | undefined;
  const progress: string[] = [];
  const provider = new KimiAgentExecutionProvider({
    run: async (input) => {
      capturedAgent = input.agent ?? '';
      capturedTitle = input.title;
      capturedWorkDir = input.workDir;
      input.onProgress?.({ message: 'created kimi session session-42', sessionId: 'session-42' });
      return { sessionId: 'session-42', output: ['ok'] };
    },
  });
  const result = await provider.execute({
    plan: {
      model: { id: 'kimi-latest' },
      tickets: [{ label: 'feat/01' }],
      checkout: { worktreePath: '/repo/.worktree/feat' },
    } as never,
    ticketIndex: 0,
    prompt: 'run',
    onProgress: (event) => progress.push(`${event.ticketLabel}: ${event.message}`),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.sessionId, 'session-42');
  assert.equal(result.removable, true);
  assert.equal(capturedAgent, '');
  assert.equal(capturedTitle, 'afk: feat/01');
  assert.equal(capturedWorkDir, '/repo/.worktree/feat');
  assert.deepEqual(progress, [
    'feat/01: starting kimi session',
    'feat/01: created kimi session session-42',
    'feat/01: kimi session completed',
  ]);
});

test('kimi reviewer invocation does not set agent', async () => {
  let capturedAgent: string | undefined = 'unset';
  const provider = new KimiAgentExecutionProvider({
    run: async (input) => {
      capturedAgent = input.agent;
      return { sessionId: 'session-review', output: ['{"summary":"ok","findings":[]}'] };
    },
  });

  const result = await provider.execute({
    plan: {
      model: { id: 'kimi-latest' },
      reviewerModel: { id: 'kimi-latest' },
      tickets: [{ label: 'feat/01' }],
    } as never,
    ticketIndex: 0,
    prompt: 'review',
    invocationMode: 'reviewer',
  });

  assert.equal(capturedAgent, undefined);
  assert.equal(result.status, 'completed');
});

test('kimi execution resumes existing session when provided', async () => {
  let capturedSessionId: string | null | undefined;
  const provider = new KimiAgentExecutionProvider({
    run: async (input) => {
      capturedSessionId = input.sessionId;
      return { sessionId: 'session-existing', output: ['ok'] };
    },
  });

  await provider.execute({
    plan: { model: { id: 'kimi-latest' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'continue',
    invocationMode: 'execution',
    sessionId: 'session-existing',
  });

  assert.equal(capturedSessionId, 'session-existing');
});

test('kimi reviewer does not resume implementation session', async () => {
  let capturedSessionId: string | null | undefined = 'unset';
  const provider = new KimiAgentExecutionProvider({
    run: async (input) => {
      capturedSessionId = input.sessionId;
      return { sessionId: 'session-review', output: ['{"summary":"ok","findings":[]}'] };
    },
  });

  await provider.execute({
    plan: {
      model: { id: 'kimi-latest' },
      reviewerModel: { id: 'kimi-latest' },
      tickets: [{ label: 'feat/01' }],
    } as never,
    ticketIndex: 0,
    prompt: 'review',
    invocationMode: 'reviewer',
    sessionId: 'session-existing',
  });

  assert.equal(capturedSessionId, null);
});

test('kimi provider maps executor failures to failed status', async () => {
  const provider = new KimiAgentExecutionProvider({
    run: async () => {
      throw new Error('sdk exploded');
    },
  });
  const result = await provider.execute({
    plan: { model: { id: 'kimi-latest' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
  });
  assert.equal(result.status, 'failed');
  assert.match(result.unsafeReason ?? '', /sdk exploded/);
});

test('kimi provider detects kimi-specific failures', async () => {
  const progress: string[] = [];
  const provider = new KimiAgentExecutionProvider({
    run: async () => ({
      sessionId: 'session-kimi-error',
      output: ['kimi error: CLI not found'],
    }),
  });

  const result = await provider.execute({
    plan: { model: { id: 'kimi-latest' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
    onProgress: (event) => progress.push(`${event.kind ?? 'message'}:${event.message}`),
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.sessionId, 'session-kimi-error');
  assert.equal(result.removable, false);
  assert.match(result.unsafeReason ?? '', /kimi error: CLI not found/);
  assert.match(progress.join('\n'), /failure:provider failure/);
});

test('kimi provider forwards permission progress events', async () => {
  const progress: string[] = [];
  const provider = new KimiAgentExecutionProvider({
    run: async (input) => {
      input.onProgress?.({
        kind: 'permission',
        message: 'kimi permission required: bash for /tmp/*; requested ask',
        sessionId: 'session-42',
        permissionId: 'per_1',
        permissionPatterns: ['/tmp/*'],
      });
      return { sessionId: 'session-42', output: ['ok'] };
    },
  });

  await provider.execute({
    plan: { tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
    onProgress: (event) => progress.push(`${event.kind ?? 'message'}:${event.ticketLabel}:${event.message}`),
  });

  assert.deepEqual(progress, [
    'message:feat/01:starting kimi session',
    'permission:feat/01:kimi permission required: bash for /tmp/*; requested ask',
    'message:feat/01:kimi session completed',
  ]);
});

test('kimi provider enables yoloMode on session creation', async () => {
  let capturedYoloMode: boolean | undefined;
  let capturedExecutable: string | undefined;
  let capturedEnv: Record<string, string> | undefined;
  let capturedShareDir: string | undefined;
  let capturedSkillsDir: string | undefined;

  const mockFactory = (options: {
    yoloMode?: boolean;
    executable?: string;
    env?: Record<string, string>;
    shareDir?: string;
    skillsDir?: string;
  }) => {
    capturedYoloMode = options.yoloMode;
    capturedExecutable = options.executable;
    capturedEnv = options.env;
    capturedShareDir = options.shareDir;
    capturedSkillsDir = options.skillsDir;
    return {
      sessionId: 'session-yolo',
      prompt: () => {
        const turn = {
          result: Promise.resolve({ status: 'finished' as const }),
          async *[Symbol.asyncIterator]() {},
          interrupt: () => Promise.resolve(),
          approve: () => Promise.resolve(),
        };
        return turn;
      },
      close: () => Promise.resolve(),
    } as never;
  };

  const customExecutor = new KimiSessionExecutor(mockFactory);
  const provider = new KimiAgentExecutionProvider(customExecutor);

  await provider.execute({
    plan: { model: { id: 'kimi-latest' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
  });

  assert.equal(capturedYoloMode, true);
  assert.match(capturedExecutable ?? '', /kimi-bare$/);
  assert.ok(capturedEnv?.AFK_KIMI_CONFIG_FILE);
  assert.equal(capturedEnv?.AFK_KIMI_EMPTY_MCP_CONFIG, '{}');
  assert.equal(capturedEnv?.KIMI_SHARE_DIR, capturedShareDir);
  assert.match(capturedShareDir ?? '', /share$/);
  assert.match(capturedSkillsDir ?? '', /skills$/);
});
