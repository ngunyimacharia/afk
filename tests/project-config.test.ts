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
