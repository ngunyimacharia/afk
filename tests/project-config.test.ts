import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadAfkProjectConfig, validateAfkProjectConfig } from '../src/project-config.js';

test('loads valid afk project config', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-config-'));
  writeFileSync(
    path.join(repoRoot, 'afk.json'),
    JSON.stringify({
      testsEnabled: true,
      smokeTestCommand: 'npm test -- {testFile}',
      staticCheckCommands: ['npm run lint --silent'],
    }),
  );

  const result = loadAfkProjectConfig(repoRoot);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.config, {
    testsEnabled: true,
    smokeTestCommand: 'npm test -- {testFile}',
    staticCheckCommands: ['npm run lint --silent'],
    provider: { kind: 'scratch' },
  });
});

test('requires smoke test command when tests are enabled', () => {
  const result = validateAfkProjectConfig({ testsEnabled: true, staticCheckCommands: [] });

  assert.equal(result.config, undefined);
  assert.match(result.errors.join('\n'), /smokeTestCommand is required/);
});

test('rejects unknown smoke command placeholders', () => {
  const result = validateAfkProjectConfig({
    testsEnabled: true,
    smokeTestCommand: 'npm test -- {ticket}',
    staticCheckCommands: [],
  });

  assert.equal(result.config, undefined);
  assert.match(result.errors.join('\n'), /unknown placeholder/);
});

test('allows tests disabled without smoke command', () => {
  const result = validateAfkProjectConfig({ testsEnabled: false });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.config, { testsEnabled: false, staticCheckCommands: [], provider: { kind: 'scratch' } });
});

test('loads linear GraphQL provider config', () => {
  const result = validateAfkProjectConfig({
    testsEnabled: false,
    provider: {
      kind: 'linear-graphql',
      team: { key: 'AFK' },
      afkLabelName: 'afk',
      projectId: 'project-123',
      workflowStates: {
        ready: { name: 'Ready for agent' },
        running: { id: 'state-running' },
        done: { name: 'Done', id: 'state-done' },
        handoff: { name: 'Ready for human' },
      },
    },
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.config?.provider, {
    kind: 'linear-graphql',
    team: { key: 'AFK' },
    afkLabelName: 'afk',
    projectId: 'project-123',
    workflowStates: {
      ready: { name: 'Ready for agent' },
      running: { id: 'state-running' },
      done: { name: 'Done', id: 'state-done' },
      handoff: { name: 'Ready for human' },
    },
  });
});

test('rejects malformed provider config with actionable errors', () => {
  const result = validateAfkProjectConfig({
    testsEnabled: false,
    provider: {
      kind: 'linear-graphql',
      team: {},
      afkLabelName: ' ',
      apiKey: 'secret',
      workflowStates: {
        ready: { name: '' },
        running: { id: 'state-running' },
        done: {},
      },
    },
  });

  assert.equal(result.config, undefined);
  assert.match(result.errors.join('\n'), /provider\.team must include key or id/);
  assert.match(result.errors.join('\n'), /provider\.afkLabelName must be a non-empty string/);
  assert.match(result.errors.join('\n'), /provider\.workflowStates\.ready\.name must be a non-empty string/);
  assert.match(result.errors.join('\n'), /provider\.workflowStates\.done must include name or id/);
  assert.match(result.errors.join('\n'), /provider\.workflowStates\.handoff must be an object/);
  assert.match(result.errors.join('\n'), /provider\.apiKey must not be stored in afk\.json/);
});

test('rejects credentials nested under workflow states config', () => {
  const result = validateAfkProjectConfig({
    testsEnabled: false,
    provider: {
      kind: 'linear-graphql',
      team: { key: 'AFK' },
      afkLabelName: 'afk',
      workflowStates: {
        ready: { name: 'Ready for agent' },
        running: { id: 'state-running' },
        done: { name: 'Done' },
        handoff: { name: 'Ready for human' },
        apiKey: 'secret',
      },
    },
  });

  assert.equal(result.config, undefined);
  assert.match(result.errors.join('\n'), /provider\.workflowStates\.apiKey must not be stored in afk\.json/);
});

test('rejects provider api key spellings with separators', () => {
  const result = validateAfkProjectConfig({
    testsEnabled: false,
    provider: { kind: 'scratch', api_key: 'secret', 'api-key': 'secret' },
  });

  assert.equal(result.config, undefined);
  assert.match(result.errors.join('\n'), /provider\.api_key must not be stored in afk\.json/);
  assert.match(result.errors.join('\n'), /provider\.api-key must not be stored in afk\.json/);
});

test('rejects credentials deeply nested under unknown provider config objects', () => {
  const result = validateAfkProjectConfig({
    testsEnabled: false,
    provider: {
      kind: 'linear-graphql',
      team: { key: 'AFK' },
      afkLabelName: 'afk',
      workflowStates: {
        ready: { name: 'Ready for agent' },
        running: { id: 'state-running' },
        done: { name: 'Done' },
        handoff: { name: 'Ready for human' },
        extra: { apiKey: 'secret' },
      },
    },
  });

  assert.equal(result.config, undefined);
  assert.match(result.errors.join('\n'), /provider\.workflowStates\.extra\.apiKey must not be stored in afk\.json/);
});

test('loads optional Linear project config', () => {
  const result = validateAfkProjectConfig({
    testsEnabled: false,
    linear: {
      team: ' ENG ',
      afkLabel: ' AFK ',
      workflowStates: {
        ready: ' Ready ',
        running: ' In Progress ',
        done: ' Done ',
        handoff: ' Handoff ',
      },
    },
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.config?.linear, {
    team: 'ENG',
    afkLabel: 'AFK',
    labelName: 'AFK',
    workflowStates: {
      ready: 'Ready',
      running: 'In Progress',
      done: 'Done',
      handoff: 'Handoff',
    },
    afkLabelName: 'AFK',
    readyStateName: 'Ready',
  });
});

test('validates linear readiness config without storing secrets', () => {
  const result = validateAfkProjectConfig({
    testsEnabled: false,
    staticCheckCommands: [],
    linear: {
      teamId: ' team-1 ',
      labelName: ' AFK ',
      workflowStates: {
        ready: 'Ready for AFK',
        running: 'AFK Running',
        done: 'Done',
        handoff: 'Needs Human',
      },
      apiKeyEnv: 'AFK_LINEAR_API_KEY',
    },
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.config?.linear, {
    team: 'team-1',
    afkLabel: 'AFK',
    teamId: 'team-1',
    labelName: 'AFK',
    workflowStates: {
      ready: 'Ready for AFK',
      running: 'AFK Running',
      done: 'Done',
      handoff: 'Needs Human',
    },
    apiKeyEnv: 'AFK_LINEAR_API_KEY',
    afkLabelName: 'AFK',
    readyStateName: 'Ready for AFK',
  });
});

test('reports incomplete linear setup and rejects inline secrets', () => {
  const result = validateAfkProjectConfig({
    testsEnabled: false,
    staticCheckCommands: [],
    linear: {
      teamId: 'team-1',
      apiKey: 'secret',
      workflowStates: { ready: 'Ready', running: 'Running', done: 'Done' },
    },
  });

  assert.equal(result.config, undefined);
  assert.match(result.errors.join('\n'), /dedicated AFK label/);
  assert.match(result.errors.join('\n'), /workflowStates\.handoff/);
  assert.match(result.errors.join('\n'), /must not include API keys or tokens/);
});

function linearGraphqlProvider(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'linear-graphql',
    team: { key: 'AFK' },
    afkLabelName: 'afk',
    workflowStates: {
      ready: { name: 'Ready for agent' },
      running: { id: 'state-running' },
      done: { name: 'Done' },
      handoff: { name: 'Ready for human' },
    },
    ...overrides,
  };
}

test('accepts valid linear.projectId for linear-graphql provider', () => {
  const result = validateAfkProjectConfig({
    testsEnabled: false,
    linear: {
      team: 'AFK',
      labelName: 'afk',
      projectId: 'project-linear',
      workflowStates: { ready: 'Ready', running: 'Running', done: 'Done', handoff: 'Handoff' },
    },
    provider: linearGraphqlProvider(),
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.config?.linear?.projectId, 'project-linear');
  assert.equal((result.config?.provider as { projectId: string }).projectId, 'project-linear');
});

test('accepts valid provider.projectId for linear-graphql provider', () => {
  const result = validateAfkProjectConfig({
    testsEnabled: false,
    provider: linearGraphqlProvider({ projectId: 'project-provider' }),
  });

  assert.deepEqual(result.errors, []);
  assert.equal((result.config?.provider as { projectId: string }).projectId, 'project-provider');
});

test('provider.projectId takes precedence over linear.projectId', () => {
  const result = validateAfkProjectConfig({
    testsEnabled: false,
    linear: {
      team: 'AFK',
      labelName: 'afk',
      projectId: 'project-linear',
      workflowStates: { ready: 'Ready', running: 'Running', done: 'Done', handoff: 'Handoff' },
    },
    provider: linearGraphqlProvider({ projectId: 'project-provider' }),
  });

  assert.deepEqual(result.errors, []);
  assert.equal((result.config?.provider as { projectId: string }).projectId, 'project-provider');
});

test('rejects linear-graphql provider when projectId is missing', () => {
  const result = validateAfkProjectConfig({
    testsEnabled: false,
    provider: linearGraphqlProvider(),
  });

  assert.equal(result.config, undefined);
  assert.match(result.errors.join('\n'), /linear\.projectId or provider\.projectId/);
});

test('rejects invalid or empty projectId values', () => {
  const linearBase = {
    team: 'AFK',
    labelName: 'afk',
    workflowStates: { ready: 'Ready', running: 'Running', done: 'Done', handoff: 'Handoff' },
  };

  const emptyLinear = validateAfkProjectConfig({
    testsEnabled: false,
    linear: { ...linearBase, projectId: '   ' },
    provider: linearGraphqlProvider(),
  });
  assert.equal(emptyLinear.config, undefined);
  assert.match(emptyLinear.errors.join('\n'), /linear\.projectId must be a non-empty string/);

  const emptyProvider = validateAfkProjectConfig({
    testsEnabled: false,
    provider: linearGraphqlProvider({ projectId: '' }),
  });
  assert.equal(emptyProvider.config, undefined);
  assert.match(emptyProvider.errors.join('\n'), /provider\.projectId must be a non-empty string/);

  const numericProjectId = validateAfkProjectConfig({
    testsEnabled: false,
    provider: linearGraphqlProvider({ projectId: 123 as unknown as string }),
  });
  assert.equal(numericProjectId.config, undefined);
  assert.match(numericProjectId.errors.join('\n'), /provider\.projectId must be a non-empty string/);
});
