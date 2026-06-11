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
    teamId: 'team-1',
    labelName: 'AFK',
    workflowStates: {
      ready: 'Ready for AFK',
      running: 'AFK Running',
      done: 'Done',
      handoff: 'Needs Human',
    },
    apiKeyEnv: 'AFK_LINEAR_API_KEY',
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
