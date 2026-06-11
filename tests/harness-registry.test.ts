import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeKimiAgentExecutionProvider, OpenCodeAgentExecutionProvider } from '../src/agent-execution-provider.js';
import { ClaudeCodeSessionExecutor } from '../src/claude-code.js';
import {
  createHarnessAgentExecutionProvider,
  createHarnessExecutor,
  displayNameForHarness,
  isHarnessId,
  isSelectableHarnessId,
  providerNameForHarness,
  selectableHarnessIds,
} from '../src/harness-registry.js';
import { SDKOpenCodeSessionExecutor, type OpenCodeSessionExecutor } from '../src/opencode.js';

test('registry exposes only current selectable harnesses', () => {
  assert.deepEqual(selectableHarnessIds(), ['OpenCode', 'Claude-Kimi']);
  assert.equal(isHarnessId('Codex'), true);
  assert.equal(isSelectableHarnessId('Codex'), false);
  assert.equal(isSelectableHarnessId('OpenCode'), true);
  assert.equal(isSelectableHarnessId('Claude-Kimi'), true);
});

test('registry preserves harness display and provider names', () => {
  assert.equal(displayNameForHarness('OpenCode'), 'OpenCode');
  assert.equal(providerNameForHarness('OpenCode'), 'opencode');
  assert.equal(displayNameForHarness('Claude-Kimi'), 'Claude-Kimi');
  assert.equal(providerNameForHarness('Claude-Kimi'), 'claude-kimi');
});

test('registry creates existing harness executors', () => {
  assert.ok(createHarnessExecutor('OpenCode') instanceof SDKOpenCodeSessionExecutor);
  assert.ok(createHarnessExecutor('Claude-Kimi') instanceof ClaudeCodeSessionExecutor);
});

test('registry creates existing harness providers', () => {
  const executor: OpenCodeSessionExecutor = { run: async () => ({ sessionId: 'session-1', output: ['ok'] }) };

  assert.ok(createHarnessAgentExecutionProvider('OpenCode', executor) instanceof OpenCodeAgentExecutionProvider);
  assert.ok(createHarnessAgentExecutionProvider('Claude-Kimi', executor) instanceof ClaudeKimiAgentExecutionProvider);
});
