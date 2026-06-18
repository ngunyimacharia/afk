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
