import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildLaunchPlan } from '../src/launch-context-builder.js';
import { resolveSandcastleAgentProvider, validateSandcastleDockerAuth } from '../src/sandcastle-provider.js';
import {
  AFK_RUNTIME_IMAGE,
  AFK_RUNTIME_PHASE_EXECUTOR_CAPABILITY,
  AFK_RUNTIME_PROVIDER_CONFIG_TARGETS,
  AFK_RUNTIME_WORKTREE_PATH,
  type SandcastleRuntimeImageClient,
  validateSandcastleRuntimeImage,
} from '../src/sandcastle-runtime-image-contract.js';
import { type SandcastleRuntimeCreateInput, SandcastleRuntimeStore } from '../src/sandcastle-runtime-store.js';

function createInput(overrides: Partial<SandcastleRuntimeCreateInput> = {}): SandcastleRuntimeCreateInput {
  return {
    runId: 'run-1',
    ticket: {
      featureSlug: 'feature-a',
      issueName: '001',
      label: 'feature-a/001',
      ticketPath: '/tmp/001.md',
    },
    trackerSource: 'scratch',
    provider: {
      provider: 'opencode',
      model: 'openai/gpt-5.5',
      reviewerProvider: 'claude',
      reviewerModel: 'sonnet',
    },
    sandbox: {
      mode: 'docker',
      image: AFK_RUNTIME_IMAGE,
      worktreePath: AFK_RUNTIME_WORKTREE_PATH,
      containerName: 'afk-run-1',
    },
    location: {
      branch: 'afk/feature-a/001',
      branchNameSource: 'fallback',
      worktreeName: 'feature-a-001',
      worktreePath: '/tmp/worktree',
    },
    ...overrides,
  };
}

test('creates a Sandcastle runtime record in the new runtime directory', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-sandcastle-runtime-'));
  const store = new SandcastleRuntimeStore({ repoRoot, now: () => 0 });

  const handle = store.createRun(createInput());

  assert.equal(
    handle.recordPath,
    path.join(repoRoot, '.scratch', 'sandcastle-runtime', 'runs', 'run-1', 'record.json'),
  );
  const record = JSON.parse(readFileSync(handle.recordPath, 'utf8'));
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.ticket.label, 'feature-a/001');
  assert.equal(record.trackerSource, 'scratch');
  assert.deepEqual(record.provider, {
    provider: 'opencode',
    model: 'openai/gpt-5.5',
    reviewerProvider: 'claude',
    reviewerModel: 'sonnet',
  });
  assert.equal(record.sandbox.mode, 'docker');
  assert.equal(record.branch, 'afk/feature-a/001');
  assert.equal(record.branchNameSource, 'fallback');
  assert.equal(record.worktreeName, 'feature-a-001');
  assert.equal(record.worktreePath, '/tmp/worktree');
  assert.equal(record.terminal.status, 'running');
  assert.deepEqual(record.sandbox, {
    mode: 'docker',
    image: AFK_RUNTIME_IMAGE,
    worktreePath: AFK_RUNTIME_WORKTREE_PATH,
    containerName: 'afk-run-1',
  });
  assert.deepEqual(record.providerFailures, []);
  assert.deepEqual(record.phases, []);
  assert.deepEqual(record.cleanupResources, []);
});

test('maps AFK harness selections to Sandcastle agent providers', () => {
  const homeDir = '/home/runner';

  assert.equal(resolveSandcastleAgentProvider('OpenCode', { id: 'openai/gpt-5.5' }, { homeDir }).provider, 'opencode');
  assert.equal(
    resolveSandcastleAgentProvider('Claude', { id: 'anthropic/claude-sonnet-4' }, { homeDir }).provider,
    'claudeCode',
  );
  assert.equal(resolveSandcastleAgentProvider('Codex', { id: 'codex/gpt-5.1-codex' }, { homeDir }).provider, 'codex');
  assert.equal(resolveSandcastleAgentProvider('PI', { id: 'pi/openai/gpt-5.1' }, { homeDir }).provider, 'pi');
});

test('launch plans carry Sandcastle provider selections for runtime orchestration', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-sandcastle-launch-plan-'));

  const plan = buildLaunchPlan(
    repoRoot,
    { id: 'codex/default' },
    [],
    {
      featureSlug: 'feature-a',
      defaultWorktreeName: 'feature-a',
      effectiveWorktreeName: 'feature-a',
      defaultBranchName: 'feature-a',
      effectiveBranchName: 'feature-a',
      branchNameSource: 'fallback',
      worktreePath: repoRoot,
    },
    {
      harness: 'Claude',
      model: { id: 'anthropic/claude-sonnet-4' },
      prompt: { id: 'reviewer-default', label: 'Default reviewer', path: '/tmp/reviewer.md' },
    },
    undefined,
    undefined,
    'Codex',
  );

  assert.equal(plan.sandcastleProvider?.provider, 'codex');
  assert.equal(plan.sandcastleProvider?.model, undefined);
  assert.equal(plan.reviewerSandcastleProvider?.provider, 'claudeCode');
  assert.equal(plan.reviewerSandcastleProvider?.model, 'anthropic/claude-sonnet-4');
});

test('normalizes Sandcastle model IDs and provider Docker requirements', () => {
  const opencode = resolveSandcastleAgentProvider('OpenCode', { id: 'openai/gpt-5.5' }, { homeDir: '/home/runner' });
  const claudeDefault = resolveSandcastleAgentProvider('Claude', { id: 'default-model' }, { homeDir: '/home/runner' });
  const codexDefault = resolveSandcastleAgentProvider('Codex', { id: 'codex/default' }, { homeDir: '/home/runner' });

  assert.equal(opencode.model, 'openai/gpt-5.5');
  assert.equal(claudeDefault.model, undefined);
  assert.equal(codexDefault.model, undefined);
  assert.deepEqual(opencode.docker.env, ['OPENCODE_AUTH']);
  assert.equal(opencode.docker.mounts[0]?.target, AFK_RUNTIME_PROVIDER_CONFIG_TARGETS.opencode);
  assert.deepEqual(resolveSandcastleAgentProvider('Claude', undefined, { homeDir: '/home/runner' }).docker.env, [
    'ANTHROPIC_API_KEY',
  ]);
  assert.equal(
    resolveSandcastleAgentProvider('Claude', undefined, { homeDir: '/home/runner' }).docker.mounts[0]?.target,
    AFK_RUNTIME_PROVIDER_CONFIG_TARGETS.claudeCode,
  );
  assert.deepEqual(resolveSandcastleAgentProvider('Codex', undefined, { homeDir: '/home/runner' }).docker.env, [
    'OPENAI_API_KEY',
  ]);
  assert.equal(
    resolveSandcastleAgentProvider('Codex', undefined, { homeDir: '/home/runner' }).docker.mounts[0]?.target,
    AFK_RUNTIME_PROVIDER_CONFIG_TARGETS.codex,
  );
  const pi = resolveSandcastleAgentProvider('PI', { id: 'pi/default' }, { homeDir: '/home/runner' });
  assert.deepEqual(pi.docker.env, ['PI_API_KEY']);
  assert.deepEqual(
    pi.docker.mounts.map((mount) => mount.source),
    ['/home/runner/.pi'],
  );
  assert.equal(pi.docker.mounts[0]?.target, AFK_RUNTIME_PROVIDER_CONFIG_TARGETS.pi);
  assert.equal(pi.noSandbox?.enabled, true);
  assert.equal(pi.model, undefined);

  const dockerPi = resolveSandcastleAgentProvider('PI', { id: 'pi/default' }, { homeDir: '/home/runner' }, 'docker');
  assert.equal(dockerPi.noSandbox, undefined);
});

test('validates AFK runtime image capability through a Sandcastle image client', async () => {
  const client: SandcastleRuntimeImageClient = {
    imageExists: async (image) => image === AFK_RUNTIME_IMAGE,
    imageExposesCapability: async (_image, capability) => capability === AFK_RUNTIME_PHASE_EXECUTOR_CAPABILITY,
  };

  const result = await validateSandcastleRuntimeImage(client);

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.image : '', AFK_RUNTIME_IMAGE);
  assert.equal(result.ok ? result.capability : '', AFK_RUNTIME_PHASE_EXECUTOR_CAPABILITY);
});

test('reports missing AFK runtime image clearly', async () => {
  const client: SandcastleRuntimeImageClient = {
    imageExists: async () => false,
    imageExposesCapability: async () => {
      throw new Error('capability check should not run');
    },
  };

  const result = await validateSandcastleRuntimeImage(client);

  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.failure.kind, 'missing-image');
  assert.match(result.ok ? '' : result.failure.message, /afk-runtime:latest is not available/);
});

test('reports AFK runtime images without the phase executor capability', async () => {
  const client: SandcastleRuntimeImageClient = {
    imageExists: async () => true,
    imageExposesCapability: async () => false,
  };

  const result = await validateSandcastleRuntimeImage(client);

  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.failure.kind, 'missing-phase-executor');
  assert.match(result.ok ? '' : result.failure.message, /does not expose required capability/);
});

test('reports missing provider Docker auth clearly', () => {
  const selection = resolveSandcastleAgentProvider(
    'Claude',
    { id: 'anthropic/claude-sonnet-4' },
    { homeDir: '/home/runner' },
  );

  const failure = validateSandcastleDockerAuth(selection, {
    env: {},
    pathExists: () => false,
  });

  assert.equal(failure?.provider, 'claudeCode');
  assert.equal(failure?.kind, 'missing-auth');
  assert.deepEqual(failure?.missingEnv, ['ANTHROPIC_API_KEY']);
  assert.deepEqual(
    failure?.missingMounts?.map((mount) => mount.source),
    ['/home/runner/.claude'],
  );
  assert.match(failure?.message ?? '', /Sandcastle claudeCode Docker auth is unavailable/);
});

test('represents no-sandbox runs', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-sandcastle-runtime-none-'));
  const store = new SandcastleRuntimeStore({ repoRoot });

  const handle = store.createRun(createInput({ runId: 'run-none', sandbox: { mode: 'none' } }));

  const record = store.readRun(handle.recordPath);
  assert.deepEqual(record.sandbox, { mode: 'none' });
});


test('updates Docker container identity on runtime records', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-sandcastle-runtime-identity-'));
  const store = new SandcastleRuntimeStore({ repoRoot, now: () => 0 });
  const handle = store.createRun(createInput());

  const record = store.updateDockerContainerIdentity(handle.recordPath, { containerId: 'abc123' });

  assert.equal(record.sandbox.mode, 'docker');
  if (record.sandbox.mode === 'docker') assert.equal(record.sandbox.containerId, 'abc123');
});

test('records implementation, review, and fixup phase attempts', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-sandcastle-runtime-phases-'));
  let tick = 0;
  const store = new SandcastleRuntimeStore({ repoRoot, now: () => tick++ * 1000 });
  const handle = store.createRun(createInput());

  store.recordPhase(handle.recordPath, {
    phase: 'implementation',
    status: 'passed',
    outcome: 'implemented ticket',
    commits: [{ sha: 'abc123', subject: 'feat: add schema' }],
    logPath: '/tmp/implementation.log',
  });
  store.recordPhase(handle.recordPath, {
    phase: 'review',
    status: 'failed',
    attempt: 1,
    outcome: 'review requested fixes',
  });
  const record = store.recordPhase(handle.recordPath, {
    phase: 'fixup',
    status: 'passed',
    attempt: 1,
    outcome: 'fixed review findings',
  });

  assert.deepEqual(
    record.phases.map((phase) => phase.phase),
    ['implementation', 'review', 'fixup'],
  );
  assert.equal(record.phases[0]?.attempt, 1);
  assert.equal(record.phases[0]?.status, 'passed');
  assert.deepEqual(record.commits, [{ sha: 'abc123', subject: 'feat: add schema' }]);
  assert.deepEqual(record.logs.phases, ['/tmp/implementation.log']);
});

test('updates terminal status and handoff reason', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-sandcastle-runtime-terminal-'));
  const store = new SandcastleRuntimeStore({ repoRoot, now: () => 0 });
  const handle = store.createRun(createInput());

  const record = store.updateTerminal(handle.recordPath, {
    status: 'handoff',
    handoffReason: 'review needs human judgement',
  });

  assert.equal(record.terminal.status, 'handoff');
  assert.equal(record.terminal.handoffReason, 'review needs human judgement');
  assert.equal(record.terminal.completedAt, '1970-01-01T00:00:00.000Z');
});

test('records cleanup resources', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-sandcastle-runtime-cleanup-'));
  const store = new SandcastleRuntimeStore({ repoRoot });
  const handle = store.createRun(createInput());

  const record = store.recordCleanupResource(handle.recordPath, {
    type: 'docker-container',
    id: 'afk-run-1',
    cleanupCommand: 'docker rm -f afk-run-1',
  });

  assert.deepEqual(record.cleanupResources, [
    {
      type: 'docker-container',
      id: 'afk-run-1',
      cleanupCommand: 'docker rm -f afk-run-1',
    },
  ]);
});

test('records provider-specific failures in the runtime schema', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-sandcastle-runtime-provider-failure-'));
  const store = new SandcastleRuntimeStore({ repoRoot, now: () => 0 });
  const handle = store.createRun(createInput());
  const failure = validateSandcastleDockerAuth(
    resolveSandcastleAgentProvider('Codex', undefined, { homeDir: '/home/runner' }),
    { env: {}, pathExists: () => false },
  );

  assert.ok(failure);
  const record = store.recordProviderFailure(handle.recordPath, failure, 'implementation');

  assert.equal(record.providerFailures.length, 1);
  assert.equal(record.providerFailures[0]?.provider, 'codex');
  assert.equal(record.providerFailures[0]?.phase, 'implementation');
  assert.equal(record.providerFailures[0]?.occurredAt, '1970-01-01T00:00:00.000Z');
});

test('does not read or migrate old opencode runtime artifacts', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-sandcastle-runtime-legacy-'));
  const legacyRoot = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata');
  mkdirSync(legacyRoot, { recursive: true });
  writeFileSync(path.join(legacyRoot, 'feature-a-001.json'), 'not json', 'utf8');
  const store = new SandcastleRuntimeStore({ repoRoot });

  const handle = store.createRun(createInput());

  assert.equal(handle.recordPath.includes('.opencode-afk-logs'), false);
  assert.equal(readFileSync(path.join(legacyRoot, 'feature-a-001.json'), 'utf8'), 'not json');
});
