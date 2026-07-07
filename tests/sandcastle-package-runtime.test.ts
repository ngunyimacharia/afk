import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentProvider, SandboxRunOptions } from '@ai-hero/sandcastle';
import {
  type AfkSandcastleDockerRuntimeInput,
  checkAfkSandcastleWarmDockerRuntimeCapability,
  createAfkSandcastleAgentProvider,
  createAfkSandcastleDockerRuntime,
} from '../src/sandcastle-package-runtime.js';

const fakeAgent: AgentProvider = {
  name: 'fake-agent',
  env: {},
  captureSessions: false,
  buildPrintCommand: () => ({ command: 'fake-agent' }),
  parseStreamLine: () => [],
};

function createInput(overrides: Partial<AfkSandcastleDockerRuntimeInput> = {}): AfkSandcastleDockerRuntimeInput {
  return {
    repoRoot: '/repo',
    branch: 'afk/feature/001',
    imageName: 'afk-runtime:test',
    env: { OPENAI_API_KEY: 'test-key' },
    mounts: [{ hostPath: '/home/runner/.codex', sandboxPath: '/home/agent/.codex', readonly: true }],
    ...overrides,
  };
}

test('Sandcastle package capability check accepts a warm Docker runtime with mounts, env, identity, repeated phases, and cleanup', async () => {
  const runPrompts: string[] = [];
  const closeCalls: string[] = [];
  const dockerOptions: unknown[] = [];
  const createOptions: unknown[] = [];

  const result = await checkAfkSandcastleWarmDockerRuntimeCapability(
    {
      ...createInput(),
      agent: fakeAgent,
      prompts: ['implement phase', 'review phase'],
    },
    {
      docker: (options: unknown) => {
        dockerOptions.push(options);
        return { name: 'docker', env: {}, sandboxHomedir: '/home/agent' };
      },
      createSandbox: async (options: unknown) => {
        createOptions.push(options);
        return {
          branch: 'afk/feature/001',
          worktreePath: '/repo/.sandcastle/worktrees/001',
          run: async (runOptions: SandboxRunOptions) => {
            runPrompts.push(runOptions.prompt ?? '');
            return {
              iterations: [{ sessionId: `session-${runPrompts.length}` }],
              stdout: `ran ${runOptions.prompt}`,
              commits: [{ sha: `commit-${runPrompts.length}` }],
            };
          },
          exec: async (command: string) => ({
            stdout: command === 'hostname' ? 'container-123\n' : '',
            stderr: '',
            exitCode: 0,
          }),
          close: async () => {
            closeCalls.push('closed');
            return {};
          },
          interactive: async () => ({ commits: [], exitCode: 0 }),
          [Symbol.asyncDispose]: async () => {},
        };
      },
    },
  );

  assert.equal(result.status, 'available');
  assert.deepEqual(result.status === 'available' ? result.identity : undefined, {
    kind: 'docker-container',
    id: 'container-123',
    source: 'hostname',
  });
  assert.equal(result.status === 'available' ? result.phaseCount : 0, 2);
  assert.deepEqual(runPrompts, ['implement phase', 'review phase']);
  assert.deepEqual(closeCalls, ['closed']);
  assert.deepEqual(dockerOptions, [
    {
      imageName: 'afk-runtime:test',
      env: { OPENAI_API_KEY: 'test-key' },
      mounts: [{ hostPath: '/home/runner/.codex', sandboxPath: '/home/agent/.codex', readonly: true }],
    },
  ]);
  assert.equal((createOptions[0] as { branch: string }).branch, 'afk/feature/001');
  assert.equal((createOptions[0] as { cwd: string }).cwd, '/repo');
});

test('PI Sandcastle agent provider runs pi CLI and normalizes JSON progress events', () => {
  const agent = createAfkSandcastleAgentProvider({
    provider: 'pi',
    model: 'openai/gpt-5.1',
    docker: {
      env: ['PI_API_KEY'],
      mounts: [{ source: '/home/runner/.pi', target: '/home/sandbox/.pi', required: true }],
    },
  });

  const command = agent.buildPrintCommand?.('hello pi');
  assert.equal(agent.name, 'pi');
  assert.equal(agent.env?.HOME, '/home/sandbox');
  assert.equal(command?.command, 'pi');
  assert.deepEqual(command?.args, ['--model', 'openai/gpt-5.1', '--print', 'hello pi', '--json']);
  assert.deepEqual(agent.parseStreamLine?.('{"type":"session.started","session_id":"pi-session"}'), [
    { message: 'created pi session pi-session', sessionId: 'pi-session' },
  ]);
  assert.deepEqual(agent.parseStreamLine?.('{"type":"message","content":"done"}'), [
    { kind: 'message', activity: 'assistant', message: 'done', sessionId: undefined },
  ]);
});

test('Sandcastle package capability gate blocks when the sandbox cannot report container identity', async () => {
  const result = await createAfkSandcastleDockerRuntime(createInput(), {
    docker: () => ({ name: 'docker', env: {}, sandboxHomedir: '/home/agent' }),
    createSandbox: async () =>
      ({
        branch: 'afk/feature/001',
        worktreePath: '/repo/.sandcastle/worktrees/001',
        run: async () => ({ iterations: [], stdout: '', commits: [] }),
        close: async () => ({}),
      }) as never,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.status === 'blocked' ? result.missingCapability : undefined, 'exec');
  assert.match(result.status === 'blocked' ? result.reason : '', /identity probes/);
});
