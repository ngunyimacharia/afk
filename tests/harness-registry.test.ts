import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ClaudeAgentExecutionProvider,
  CodexAgentExecutionProvider,
  OpenCodeAgentExecutionProvider,
} from '../src/agent-execution-provider.js';
import { ClaudeCodeSessionExecutor } from '../src/claude-code.js';
import { CodexSessionExecutor } from '../src/codex.js';
import {
  createHarnessAgentExecutionProvider,
  createHarnessExecutor,
  discoverAvailableHarnesses,
  discoverHarnessModels,
  displayNameForHarness,
  isHarnessId,
  isSelectableHarnessId,
  migrateLegacyHarnessId,
  migrateLegacyProviderName,
  providerNameForHarness,
  selectableHarnessIds,
} from '../src/harness-registry.js';
import { type OpenCodeSessionExecutor, SDKOpenCodeSessionExecutor } from '../src/opencode.js';

test('registry exposes only current selectable harnesses', () => {
  assert.deepEqual(selectableHarnessIds(), ['OpenCode', 'Claude', 'Codex']);
  assert.equal(isHarnessId('Codex'), true);
  assert.equal(isSelectableHarnessId('Codex'), true);
  assert.equal(isSelectableHarnessId('OpenCode'), true);
  assert.equal(isSelectableHarnessId('Claude'), true);
});

test('registry preserves harness display and provider names', () => {
  assert.equal(displayNameForHarness('OpenCode'), 'OpenCode');
  assert.equal(providerNameForHarness('OpenCode'), 'opencode');
  assert.equal(displayNameForHarness('Claude'), 'Claude');
  assert.equal(providerNameForHarness('Claude'), 'claude');
  assert.equal(displayNameForHarness('Codex'), 'Codex');
  assert.equal(providerNameForHarness('Codex'), 'codex');
});

test('migrates legacy harness and provider names', () => {
  assert.equal(migrateLegacyHarnessId('Claude-Kimi'), 'Claude');
  assert.equal(migrateLegacyHarnessId('OpenCode'), 'OpenCode');
  assert.equal(migrateLegacyProviderName('claude-kimi'), 'claude');
  assert.equal(migrateLegacyProviderName('opencode'), 'opencode');
});

test('registry creates existing harness executors', () => {
  assert.ok(createHarnessExecutor('OpenCode') instanceof SDKOpenCodeSessionExecutor);
  assert.ok(createHarnessExecutor('Claude') instanceof ClaudeCodeSessionExecutor);
  assert.ok(createHarnessExecutor('Codex') instanceof CodexSessionExecutor);
});

test('registry creates existing harness providers', () => {
  const executor: OpenCodeSessionExecutor = { run: async () => ({ sessionId: 'session-1', output: ['ok'] }) };

  assert.ok(createHarnessAgentExecutionProvider('OpenCode', executor) instanceof OpenCodeAgentExecutionProvider);
  assert.ok(createHarnessAgentExecutionProvider('Claude', executor) instanceof ClaudeAgentExecutionProvider);
  assert.ok(createHarnessAgentExecutionProvider('Codex', executor) instanceof CodexAgentExecutionProvider);
});

test('Codex discovery makes Codex available to launch', async () => {
  const models = await discoverHarnessModels('Codex');
  assert.deepEqual(
    models.map((model) => model.id),
    ['codex/default'],
  );

  const discovery = await discoverAvailableHarnesses(async (harness) => (harness === 'Codex' ? models : []));
  assert.equal(discovery.availableHarnesses.includes('Codex'), true);
  assert.deepEqual(
    discovery.harnessModelCache.Codex?.map((model) => model.id),
    ['codex/default'],
  );
});
