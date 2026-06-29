import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ClaudeAgentExecutionProvider,
  CodexAgentExecutionProvider,
  decideAfkPermission,
  FakeAgentExecutionProvider,
  isCommandAllowed,
  OpenCodeAgentExecutionProvider,
  resolveAgentInvocationPolicy,
} from '../src/agent-execution-provider.js';
import { SDKOpenCodeSessionExecutor } from '../src/opencode.js';
import { PermissionCoordinator } from '../src/permission-coordinator.js';

test('normalizes execution outcomes and session ids', async () => {
  const provider = new FakeAgentExecutionProvider({
    status: 'failed',
    sessionId: 'abc',
    removable: false,
    unsafeReason: 'sdk session id unavailable',
  });
  const result = await provider.execute({ plan: undefined as never, ticketIndex: 0, prompt: '' });
  assert.equal(result.status, 'failed');
  assert.equal(result.sessionId, 'abc');
  assert.equal(result.removable, false);
  assert.equal(result.unsafeReason, 'sdk session id unavailable');
});

test('captures interrupted and unknown outcomes without mutation', async () => {
  const provider = new FakeAgentExecutionProvider({
    status: 'interrupted',
    sessionId: null,
    removable: true,
    output: ['stopping'],
  });
  const result = await provider.execute({ plan: undefined as never, ticketIndex: 1, prompt: 'run' });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.sessionId, null);
  assert.equal(result.removable, true);
  assert.deepEqual(result.output, ['stopping']);
});

test('opencode provider maps successful execution to completed result', async () => {
  let capturedAgent = '';
  let capturedTitle = '';
  const progress: string[] = [];
  const provider = new OpenCodeAgentExecutionProvider({
    run: async (input) => {
      capturedAgent = input.agent ?? '';
      capturedTitle = input.title;
      input.onProgress?.({ message: 'created opencode session session-42', sessionId: 'session-42' });
      return { sessionId: 'session-42', output: ['ok'] };
    },
  });
  const result = await provider.execute({
    plan: { model: { id: 'github-copilot/claude-sonnet-4.6' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
    onProgress: (event) => progress.push(`${event.ticketLabel}: ${event.message}`),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.sessionId, 'session-42');
  assert.equal(result.removable, true);
  assert.equal(capturedAgent, 'build');
  assert.equal(capturedTitle, 'afk: feat/01');
  assert.deepEqual(progress, [
    'feat/01: starting opencode session',
    'feat/01: created opencode session session-42',
    'feat/01: opencode session completed',
  ]);
});

test('codex provider marks successful sessions as not removable', async () => {
  const provider = new CodexAgentExecutionProvider({
    run: async () => ({ sessionId: 'codex-thread', output: ['done'], finalMessageText: 'done' }),
  });

  const result = await provider.execute({
    plan: { model: { id: 'codex/default' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.sessionId, 'codex-thread');
  assert.equal(result.removable, false);
});

test('opencode reviewer invocation does not force the silent review agent', async () => {
  let capturedAgent: string | undefined = 'unset';
  const provider = new OpenCodeAgentExecutionProvider({
    run: async (input) => {
      capturedAgent = input.agent;
      return { sessionId: 'session-review', output: ['{"done":true,"summary":"ok","findings":[]}'] };
    },
  });

  const result = await provider.execute({
    plan: {
      model: { id: 'openai/gpt-5.5' },
      reviewerModel: { id: 'openai/gpt-5.5' },
      tickets: [{ label: 'feat/01' }],
    } as never,
    ticketIndex: 0,
    prompt: 'review',
    invocationMode: 'reviewer',
  });

  assert.equal(capturedAgent, undefined);
  assert.equal(result.status, 'completed');
});

test('opencode pull-request invocation does not use the yolo build agent', async () => {
  let capturedAgent: string | undefined = 'unset';
  let capturedPermissionMode: string | undefined;
  let capturedTitle = '';
  const provider = new OpenCodeAgentExecutionProvider({
    run: async (input) => {
      capturedAgent = input.agent;
      capturedPermissionMode = input.permissionMode;
      capturedTitle = input.title;
      return { sessionId: 'session-pr', output: ['ok'] };
    },
  });

  await provider.execute({
    plan: { model: { id: 'openai/gpt-5.5' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'open pr',
    invocationMode: 'pull-request',
    sessionId: 'session-existing',
  });

  assert.equal(capturedAgent, undefined);
  assert.equal(capturedPermissionMode, 'ask');
  assert.equal(capturedTitle, 'afk pull request: feat/01');
});

test('opencode execution resumes existing session when provided', async () => {
  let capturedSessionId: string | null | undefined;
  const provider = new OpenCodeAgentExecutionProvider({
    run: async (input) => {
      capturedSessionId = input.sessionId;
      return { sessionId: 'session-existing', output: ['ok'] };
    },
  });

  await provider.execute({
    plan: { model: { id: 'openai/gpt-5.5' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'continue',
    invocationMode: 'execution',
    sessionId: 'session-existing',
  });

  assert.equal(capturedSessionId, 'session-existing');
});

test('opencode reviewer does not resume implementation session', async () => {
  let capturedSessionId: string | null | undefined = 'unset';
  const provider = new OpenCodeAgentExecutionProvider({
    run: async (input) => {
      capturedSessionId = input.sessionId;
      return { sessionId: 'session-review', output: ['{"done":true,"summary":"ok","findings":[]}'] };
    },
  });

  await provider.execute({
    plan: {
      model: { id: 'openai/gpt-5.5' },
      reviewerModel: { id: 'openai/gpt-5.5' },
      tickets: [{ label: 'feat/01' }],
    } as never,
    ticketIndex: 0,
    prompt: 'review',
    invocationMode: 'reviewer',
    sessionId: 'session-existing',
  });

  assert.equal(capturedSessionId, null);
});

test('opencode provider maps executor failures to failed status', async () => {
  const provider = new OpenCodeAgentExecutionProvider({
    run: async () => {
      throw new Error('sdk exploded');
    },
  });
  const result = await provider.execute({
    plan: { model: { id: 'github-copilot/claude-sonnet-4.6' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
  });
  assert.equal(result.status, 'failed');
  assert.match(result.unsafeReason ?? '', /sdk exploded/);
});

test('opencode provider maps model availability output to failed status', async () => {
  const progress: string[] = [];
  const provider = new OpenCodeAgentExecutionProvider({
    run: async () => ({
      sessionId: 'session-model-error',
      output: ['The requested model is not available for integrator "copilot-language-server".'],
    }),
  });

  const result = await provider.execute({
    plan: { model: { id: 'github-copilot/claude-sonnet-4.6' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
    onProgress: (event) => progress.push(`${event.kind ?? 'message'}:${event.message}`),
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.sessionId, 'session-model-error');
  assert.equal(result.removable, false);
  assert.match(result.unsafeReason ?? '', /requested model is not available/);
  assert.deepEqual(result.output, ['The requested model is not available for integrator "copilot-language-server".']);
  assert.match(progress.join('\n'), /failure:provider failure: selected implementation model/);
});

test('opencode provider ignores recoverable tool failures without terminal session errors', async () => {
  const provider = new OpenCodeAgentExecutionProvider({
    run: async () => ({
      sessionId: 'session-tool-error-recovered',
      output: ['tool failed: File not found: /repo/app.php', 'Implemented end-to-end and updated the ticket to done.'],
    }),
  });

  const result = await provider.execute({
    plan: { model: { id: 'openai/gpt-5.5' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.removable, true);
});

test('opencode provider completes when actual session output has recovered historical abort', async () => {
  const progress: string[] = [];
  const provider = new OpenCodeAgentExecutionProvider(
    new SDKOpenCodeSessionExecutor(
      async () =>
        ({
          server: { url: 'http://127.0.0.1:1', close() {} },
          client: {
            event: {
              subscribe: async () => ({ stream: [] }),
            },
            session: {
              create: async () => ({ id: 'session-recovered-abort' }),
              prompt: async () => ({ ok: true }),
              messages: async () => [
                {
                  role: 'assistant',
                  error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
                  parts: [{ type: 'text', text: 'stale attempt aborted' }],
                },
                {
                  role: 'assistant',
                  parts: [{ type: 'text', text: 'Recovered and completed' }],
                },
              ],
            },
          },
        }) as never,
    ),
  );

  const result = await provider.execute({
    plan: { model: { id: 'github-copilot/claude-sonnet-4.6' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
    onProgress: (event) => progress.push(`${event.kind ?? 'message'}:${event.message}`),
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.sessionId, 'session-recovered-abort');
  assert.equal(result.removable, true);
  assert.equal(result.unsafeReason, null);
  assert.deepEqual(result.output, ['opencode error: Aborted', 'stale attempt aborted', 'Recovered and completed']);
  assert.doesNotMatch(progress.join('\n'), /provider failure/);
  assert.match(progress.join('\n'), /opencode session completed/);
});

test('opencode provider fails on structured terminal session errors', async () => {
  const provider = new OpenCodeAgentExecutionProvider({
    run: async () => ({
      sessionId: 'session-terminal-error',
      output: ['attempted work'],
      terminalError: 'opencode error: provider unavailable',
    }),
  });

  const result = await provider.execute({
    plan: { model: { id: 'openai/gpt-5.5' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.unsafeReason, 'opencode error: provider unavailable');
});

test('opencode provider forwards permission progress events', async () => {
  const progress: string[] = [];
  const provider = new OpenCodeAgentExecutionProvider({
    run: async (input) => {
      input.onProgress?.({
        kind: 'permission',
        message: 'opencode permission required: external_directory for /tmp/*; requested ask',
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
    'message:feat/01:starting opencode session',
    'permission:feat/01:opencode permission required: external_directory for /tmp/*; requested ask',
    'message:feat/01:opencode session completed',
  ]);
});

test('opencode provider supplies AFK permission policy that allows assigned worktree external directories', async () => {
  let decision = '';
  const provider = new OpenCodeAgentExecutionProvider({
    run: async (input) => {
      decision =
        (await input.decidePermission?.({
          sessionId: 'session-42',
          permissionId: 'per_1',
          type: 'external_directory',
          title: 'external_directory',
          patterns: ['/repo/.worktree/feature/*'],
        })) ?? '';
      return { sessionId: 'session-42', output: ['ok'] };
    },
  });

  await provider.execute({
    plan: {
      repoRoot: '/repo',
      checkout: { worktreePath: '/repo/.worktree/feature' },
      model: { id: 'openai/gpt-5.4-mini' },
      tickets: [{ label: 'feat/01' }],
    } as never,
    ticketIndex: 0,
    prompt: 'run',
  });

  assert.equal(decision, 'always');
});

test('external directory auto-approve does not enter manual coordinator history', async () => {
  const coordinator = new PermissionCoordinator({
    promptAdapter: async () => 'once',
  });

  const decision = await decideAfkPermission(
    {
      sessionId: 'session-42',
      permissionId: 'per_1',
      type: 'external_directory',
      title: 'external_directory',
      patterns: ['/tmp/worktree/*'],
    },
    { ticketLabel: 'feat/01', coordinator, repoRoot: '/repo' },
  );

  assert.equal(decision, 'always');
  assert.equal(coordinator.history.length, 0);
});

test('external directory inside assigned worktree bypasses manual coordinator', async () => {
  const coordinator = new PermissionCoordinator({
    promptAdapter: async () => 'once',
  });

  const decision = await decideAfkPermission(
    {
      sessionId: 'session-42',
      permissionId: 'per_1',
      type: 'external_directory',
      title: 'external_directory',
      patterns: ['/repo/.worktree/feature/*'],
    },
    { ticketLabel: 'feat/01', coordinator, repoRoot: '/repo', worktreePath: '/repo/.worktree/feature' },
  );

  assert.equal(decision, 'always');
  assert.equal(coordinator.history.length, 0);
});

test('read inside assigned worktree bypasses manual coordinator', async () => {
  const coordinator = new PermissionCoordinator({
    promptAdapter: async () => 'once',
  });

  const decision = await decideAfkPermission(
    {
      sessionId: 'session-42',
      permissionId: 'per_1',
      type: 'read',
      title: 'read',
      patterns: ['.worktree/feature/.env.testing'],
    },
    { ticketLabel: 'feat/01', coordinator, repoRoot: '/repo', worktreePath: '/repo/.worktree/feature' },
  );

  assert.equal(decision, 'always');
  assert.equal(coordinator.history.length, 0);
});

test('read outside assigned worktree auto-approved without entering manual coordinator', async () => {
  const coordinator = new PermissionCoordinator({
    promptAdapter: async () => 'once',
  });

  const decision = await decideAfkPermission(
    {
      sessionId: 'session-42',
      permissionId: 'per_1',
      type: 'read',
      title: 'read',
      patterns: ['/repo/.worktree/other/.env.testing'],
    },
    { ticketLabel: 'feat/01', coordinator, repoRoot: '/repo', worktreePath: '/repo/.worktree/feature' },
  );

  assert.equal(decision, 'always');
  assert.equal(coordinator.history.length, 0);
});

test('external directory under root source is auto-approved when worktree differs', async () => {
  const decision = await decideAfkPermission(
    {
      sessionId: 'session-42',
      permissionId: 'per_1',
      type: 'external_directory',
      title: 'external_directory',
      patterns: ['/repo/app/*'],
    },
    { ticketLabel: 'feat/01', repoRoot: '/repo', worktreePath: '/repo/.worktree/feature' },
  );

  assert.equal(decision, 'always');
});

test('external directory under root scratch is allowed', async () => {
  const decision = await decideAfkPermission(
    {
      sessionId: 'session-42',
      permissionId: 'per_1',
      type: 'external_directory',
      title: 'external_directory',
      patterns: ['/repo/.scratch/feat/*'],
    },
    { ticketLabel: 'feat/01', repoRoot: '/repo', worktreePath: '/repo/.worktree/feature' },
  );

  assert.equal(decision, 'always');
});

test('external directory under another worktree is auto-approved', async () => {
  const decision = await decideAfkPermission(
    {
      sessionId: 'session-42',
      permissionId: 'per_1',
      type: 'external_directory',
      title: 'external_directory',
      patterns: ['/repo/.worktree/other/*'],
    },
    {
      ticketLabel: 'feat/01',
      repoRoot: '/repo',
      worktreePath: '/repo/.worktree/feature',
      otherWorktreePaths: ['/repo/.worktree/other'],
    },
  );

  assert.equal(decision, 'always');
});

test('AFK permission policy auto-approves all requests including bash', async () => {
  assert.equal(
    await decideAfkPermission({
      sessionId: 'session-42',
      permissionId: 'per_2',
      type: 'bash',
      title: 'bash',
      patterns: ['bun test'],
    }),
    'always',
  );
});

test('pull-request permission policy rejects source edits and scratch writes', async () => {
  const policy = resolveAgentInvocationPolicy('pull-request');

  assert.equal(
    await decideAfkPermission(
      {
        sessionId: 'session-42',
        permissionId: 'per_edit',
        type: 'edit',
        title: 'edit src/index.ts',
        patterns: ['src/index.ts'],
      },
      { policy },
    ),
    'reject',
  );
  assert.equal(
    await decideAfkPermission(
      {
        sessionId: 'session-42',
        permissionId: 'per_scratch',
        type: 'write',
        title: 'write .scratch ticket',
        patterns: ['.scratch/feature/001.md'],
      },
      { policy },
    ),
    'reject',
  );
  assert.equal(
    await decideAfkPermission(
      {
        sessionId: 'session-42',
        permissionId: 'per_read',
        type: 'read',
        title: 'read file',
        patterns: ['src/index.ts'],
      },
      { policy },
    ),
    'always',
  );
  assert.equal(
    await decideAfkPermission(
      {
        sessionId: 'session-42',
        permissionId: 'per_bash_delete',
        type: 'bash',
        title: 'bash',
        patterns: ['rm src/index.ts'],
      },
      { policy },
    ),
    'reject',
  );
  assert.equal(
    await decideAfkPermission(
      {
        sessionId: 'session-42',
        permissionId: 'per_bash_scratch',
        type: 'bash',
        title: 'bash',
        patterns: ['cat > .scratch/feature/001.md'],
      },
      { policy },
    ),
    'reject',
  );
  assert.equal(
    await decideAfkPermission(
      {
        sessionId: 'session-42',
        permissionId: 'per_bash_test',
        type: 'bash',
        title: 'bash',
        patterns: ['bun test'],
      },
      { policy },
    ),
    'always',
  );
  assert.equal(
    await decideAfkPermission(
      {
        sessionId: 'session-42',
        permissionId: 'per_bash_git_push',
        type: 'bash',
        title: 'bash',
        patterns: ['git push origin HEAD'],
      },
      { policy },
    ),
    'always',
  );
  assert.equal(
    await decideAfkPermission(
      {
        sessionId: 'session-42',
        permissionId: 'per_bash_gh_pr_create',
        type: 'bash',
        title: 'bash',
        patterns: ['gh pr create --fill'],
      },
      { policy },
    ),
    'always',
  );

  for (const [permissionId, command] of [
    ['per_bash_touch', 'touch src/new.ts'],
    ['per_bash_mv', 'mv src/a.ts src/b.ts'],
    ['per_bash_cp', 'cp template src/index.ts'],
    ['per_bash_mkdir_scratch', 'mkdir .scratch/feature'],
    ['per_bash_git_commit', 'git commit -m "update"'],
    ['per_bash_unknown', 'custom-mutator src/index.ts'],
  ] as const) {
    assert.equal(
      await decideAfkPermission(
        {
          sessionId: 'session-42',
          permissionId,
          type: 'bash',
          title: 'bash',
          patterns: [command],
        },
        { policy },
      ),
      'reject',
    );
  }

  assert.equal(
    await decideAfkPermission(
      {
        sessionId: 'session-42',
        permissionId: 'per_tool_bash_touch',
        type: 'tool',
        title: 'bash',
        patterns: ['touch src/new.ts'],
      },
      { policy },
    ),
    'reject',
  );

  assert.equal(
    await decideAfkPermission(
      {
        sessionId: 'session-42',
        permissionId: 'per_titled_bash_touch',
        type: 'tool',
        title: 'Run bash command',
        patterns: ['touch src/new.ts'],
      },
      { policy },
    ),
    'reject',
  );
});

test('opencode provider supplies pull-request permission policy to executor', async () => {
  let editDecision = '';
  const provider = new OpenCodeAgentExecutionProvider({
    run: async (input) => {
      editDecision =
        (await input.decidePermission?.({
          sessionId: 'session-42',
          permissionId: 'per_1',
          type: 'edit',
          title: 'edit src/index.ts',
          patterns: ['src/index.ts'],
        })) ?? '';
      return { sessionId: 'session-42', output: ['ok'] };
    },
  });

  await provider.execute({
    plan: { repoRoot: '/repo', model: { id: 'openai/gpt-5.5' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'open pr',
    invocationMode: 'pull-request',
  });

  assert.equal(editDecision, 'reject');
});

test('opencode provider aborts when signal is triggered', async () => {
  const controller = new AbortController();
  controller.abort();

  const provider = new OpenCodeAgentExecutionProvider({
    run: async () => ({ sessionId: 'session-abort', output: [] }),
  });

  await assert.rejects(
    provider.execute({
      plan: { model: { id: 'openai/gpt-5.5' }, tickets: [{ label: 'feat/01' }] } as never,
      ticketIndex: 0,
      prompt: 'run',
      signal: controller.signal,
    }),
    /run killed/,
  );
});

test('opencode provider forwards signal to executor', async () => {
  let capturedSignal: AbortSignal | undefined;
  const controller = new AbortController();

  const provider = new OpenCodeAgentExecutionProvider({
    run: async (input) => {
      capturedSignal = input.signal;
      return { sessionId: 'session-signal', output: ['ok'] };
    },
  });

  await provider.execute({
    plan: { model: { id: 'openai/gpt-5.5' }, tickets: [{ label: 'feat/01' }] } as never,
    ticketIndex: 0,
    prompt: 'run',
    signal: controller.signal,
  });

  assert.equal(capturedSignal, controller.signal);
});

test('opencode provider forwards workDir from checkout worktreePath', async () => {
  let capturedWorkDir: string | undefined;
  const provider = new OpenCodeAgentExecutionProvider({
    run: async (input) => {
      capturedWorkDir = input.workDir;
      return { sessionId: 'session-workdir', output: ['ok'] };
    },
  });

  await provider.execute({
    plan: {
      model: { id: 'openai/gpt-5.5' },
      tickets: [{ label: 'feat/01' }],
      checkout: { worktreePath: '/repo/.worktree/feature' },
    } as never,
    ticketIndex: 0,
    prompt: 'run',
  });

  assert.equal(capturedWorkDir, '/repo/.worktree/feature');
});

test('claude provider forwards workDir from checkout worktreePath', async () => {
  let capturedWorkDir: string | undefined;
  const provider = new ClaudeAgentExecutionProvider({
    run: async (input) => {
      capturedWorkDir = input.workDir;
      return { sessionId: 'session-workdir', output: ['ok'] };
    },
  });

  await provider.execute({
    plan: {
      model: { id: 'anthropic/claude-sonnet-4' },
      tickets: [{ label: 'feat/01' }],
      checkout: { worktreePath: '/repo/.worktree/feature' },
    } as never,
    ticketIndex: 0,
    prompt: 'run',
  });

  assert.equal(capturedWorkDir, '/repo/.worktree/feature');
});

test('shared permission coordinator serializes concurrent tickets FIFO', async () => {
  const promptOrder: string[] = [];
  const activeByPrompt: number[] = [];
  let activePrompts = 0;
  const releaseByPermission = new Map<string, () => void>();
  const coordinator = new PermissionCoordinator({
    promptAdapter: async ({ request, metadata }) => {
      activePrompts += 1;
      activeByPrompt.push(activePrompts);
      promptOrder.push(`${metadata.ticketLabel}:${request.permissionId}`);
      await new Promise<void>((resolve) => {
        releaseByPermission.set(request.permissionId, resolve);
      });
      activePrompts -= 1;
      return 'once';
    },
  });

  const first = coordinator.submitForTicket('feat-a/001', {
    sessionId: 'session-a',
    permissionId: 'per-a',
    type: 'bash',
    title: 'bash',
    patterns: ['bun test'],
  });
  const second = coordinator.submitForTicket('feat-b/001', {
    sessionId: 'session-b',
    permissionId: 'per-b',
    type: 'bash',
    title: 'bash',
    patterns: ['bun test'],
  });

  await waitFor(() => releaseByPermission.has('per-a'));
  releaseByPermission.get('per-a')?.();
  await waitFor(() => releaseByPermission.has('per-b'));
  releaseByPermission.get('per-b')?.();

  await Promise.all([first, second]);

  assert.deepEqual(promptOrder, ['feat-a/001:per-a', 'feat-b/001:per-b']);
  assert.deepEqual(activeByPrompt, [1, 1]);
  assert.deepEqual(
    coordinator.history.map((entry) => `${entry.metadata.ticketLabel}:${entry.request.permissionId}`),
    ['feat-a/001:per-a', 'feat-b/001:per-b'],
  );
});

test('reviewer policy allows scratch-write and git-commit', () => {
  const reviewerPolicy = resolveAgentInvocationPolicy('reviewer');

  assert.deepEqual(reviewerPolicy.allowedCommandKinds, ['read', 'diagnostic', 'scratch-write', 'git-commit']);
  assert.equal(reviewerPolicy.canMutateWorkspace, false);
  assert.equal(reviewerPolicy.canMutateGitState, true);
  assert.equal(reviewerPolicy.canMutateScratch, true);

  assert.equal(isCommandAllowed(reviewerPolicy, { kind: 'read' }), true);
  assert.equal(isCommandAllowed(reviewerPolicy, { kind: 'scratch-write' }), true);
  assert.equal(isCommandAllowed(reviewerPolicy, { kind: 'git-commit' }), true);
  assert.equal(isCommandAllowed(reviewerPolicy, { kind: 'write' }), false);
  assert.equal(isCommandAllowed(reviewerPolicy, { kind: 'git-push' }), false);
});

test('pull-request policy blocks workspace and scratch mutation', () => {
  const pullRequestPolicy = resolveAgentInvocationPolicy('pull-request');

  assert.deepEqual(pullRequestPolicy.allowedCommandKinds, [
    'read',
    'diagnostic',
    'git-commit',
    'git-push',
    'github-pr',
  ]);
  assert.equal(pullRequestPolicy.canMutateWorkspace, false);
  assert.equal(pullRequestPolicy.canMutateGitState, true);
  assert.equal(pullRequestPolicy.canMutateScratch, false);

  assert.equal(isCommandAllowed(pullRequestPolicy, { kind: 'read' }), true);
  assert.equal(isCommandAllowed(pullRequestPolicy, { kind: 'git-commit' }), true);
  assert.equal(isCommandAllowed(pullRequestPolicy, { kind: 'git-push' }), true);
  assert.equal(isCommandAllowed(pullRequestPolicy, { kind: 'github-pr' }), true);
  assert.equal(isCommandAllowed(pullRequestPolicy, { kind: 'write' }), false);
  assert.equal(isCommandAllowed(pullRequestPolicy, { kind: 'edit' }), false);
  assert.equal(isCommandAllowed(pullRequestPolicy, { kind: 'delete' }), false);
  assert.equal(isCommandAllowed(pullRequestPolicy, { kind: 'scratch-write' }), false);
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('condition not met before timeout');
}
