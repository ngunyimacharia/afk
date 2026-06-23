import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inferTrackerProviderKind, loadAfkProjectConfig, validateAfkProjectConfig } from '../src/project-config.js';

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
  });
});

test('loads environmentReadinessCommand when present', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-config-env-'));
  writeFileSync(
    path.join(repoRoot, 'afk.json'),
    JSON.stringify({
      testsEnabled: false,
      staticCheckCommands: [],
      environmentReadinessCommand: 'which php',
    }),
  );

  const result = loadAfkProjectConfig(repoRoot);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.config?.environmentReadinessCommand, 'which php');
});

test('rejects empty or non-string environmentReadinessCommand', () => {
  const emptyResult = validateAfkProjectConfig({
    testsEnabled: false,
    staticCheckCommands: [],
    environmentReadinessCommand: '   ',
  });
  assert.equal(emptyResult.config, undefined);
  assert.match(emptyResult.errors.join('\n'), /environmentReadinessCommand must be a non-empty string/);

  const numericResult = validateAfkProjectConfig({
    testsEnabled: false,
    staticCheckCommands: [],
    environmentReadinessCommand: 123 as unknown as string,
  });
  assert.equal(numericResult.config, undefined);
  assert.match(numericResult.errors.join('\n'), /environmentReadinessCommand must be a non-empty string/);
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
  assert.deepEqual(result.config, { testsEnabled: false, staticCheckCommands: [] });
});

test('rejects configs that contain a provider key', () => {
  const result = validateAfkProjectConfig({
    testsEnabled: false,
    provider: { kind: 'scratch' },
  });

  assert.equal(result.config, undefined);
  assert.match(result.errors.join('\n'), /provider is no longer supported/);
  assert.match(result.errors.join('\n'), /configure the linear block instead/);
});

test('infers scratch tracker provider when linear block is absent', () => {
  const config = validateAfkProjectConfig({
    testsEnabled: false,
    staticCheckCommands: [],
  }).config;

  assert.ok(config);
  assert.equal(inferTrackerProviderKind(config), 'scratch');
});

test('infers linear tracker provider when linear block is present', () => {
  const config = validateAfkProjectConfig({
    testsEnabled: false,
    staticCheckCommands: [],
    linear: {
      team: 'ENG',
      labelName: 'AFK',
      workflowStates: {
        ready: 'Ready',
        running: 'In Progress',
        done: 'Done',
        handoff: 'Handoff',
      },
    },
  }).config;

  assert.ok(config);
  assert.equal(inferTrackerProviderKind(config), 'linear');
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

test('validates linear readiness config with apiKey', () => {
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
      apiKey: ' lin_api_123456 ',
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
    apiKey: 'lin_api_123456',
    afkLabelName: 'AFK',
    readyStateName: 'Ready for AFK',
  });
});

test('rejects empty or whitespace-only linear apiKey', () => {
  const result = validateAfkProjectConfig({
    testsEnabled: false,
    staticCheckCommands: [],
    linear: {
      teamId: 'team-1',
      labelName: 'AFK',
      workflowStates: {
        ready: 'Ready',
        running: 'Running',
        done: 'Done',
        handoff: 'Handoff',
      },
      apiKey: '   ',
    },
  });

  assert.equal(result.config, undefined);
  assert.match(result.errors.join('\n'), /linear\.apiKey must be a non-empty string/);
});

test('reports incomplete linear setup', () => {
  const result = validateAfkProjectConfig({
    testsEnabled: false,
    staticCheckCommands: [],
    linear: {
      teamId: 'team-1',
      workflowStates: { ready: 'Ready', running: 'Running', done: 'Done' },
    },
  });

  assert.equal(result.config, undefined);
  assert.match(result.errors.join('\n'), /dedicated AFK label/);
  assert.match(result.errors.join('\n'), /workflowStates\.handoff/);
});

const linearBase = {
  team: 'AFK',
  labelName: 'afk',
  workflowStates: { ready: 'Ready', running: 'Running', done: 'Done', handoff: 'Handoff' },
};

test('accepts valid linear.projectId', () => {
  const result = validateAfkProjectConfig({
    testsEnabled: false,
    linear: {
      ...linearBase,
      projectId: 'project-linear',
    },
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.config?.linear?.projectId, 'project-linear');
});

test('rejects invalid or empty linear.projectId values', () => {
  const emptyProjectId = validateAfkProjectConfig({
    testsEnabled: false,
    linear: { ...linearBase, projectId: '   ' },
  });
  assert.equal(emptyProjectId.config, undefined);
  assert.match(emptyProjectId.errors.join('\n'), /linear\.projectId must be a non-empty string/);

  const numericProjectId = validateAfkProjectConfig({
    testsEnabled: false,
    linear: { ...linearBase, projectId: 123 as unknown as string },
  });
  assert.equal(numericProjectId.config, undefined);
  assert.match(numericProjectId.errors.join('\n'), /linear\.projectId must be a non-empty string/);
});
