import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyProviderFailure, formatProviderFailureMessage } from '../src/provider-failure.js';
import { detectPreflightFailureReason, formatPreflightFailure } from '../src/cli.js';

test('classifies Copilot unavailable-model errors and extracts alternatives', () => {
  const classification = classifyProviderFailure(
    'The requested model is not available for integrator "copilot-language-server". Available models: [gpt-4.1 claude-sonnet-4.5 gpt-5.2].',
  );

  assert.equal(classification?.kind, 'model-unavailable');
  assert.deepEqual(classification?.availableModels, ['gpt-4.1', 'claude-sonnet-4.5', 'gpt-5.2']);
});

test('formats concise unavailable implementation model progress message', () => {
  assert.equal(
    formatProviderFailureMessage({
      modelId: 'github-copilot/claude-sonnet-4.6',
      mode: 'execution',
      reason: 'The requested model is not available for integrator "copilot-language-server".',
    }),
    'provider failure: selected implementation model github-copilot/claude-sonnet-4.6 is unavailable',
  );
});

test('formats actionable preflight failure message', () => {
  const message = formatPreflightFailure(
    'github-copilot/claude-sonnet-4.6',
    'implementation',
    'The requested model is not available for integrator "copilot-language-server". Available models: [claude-sonnet-4.5 gpt-5.2].',
  );

  assert.match(message, /Implementation model unavailable/);
  assert.match(message, /Selected implementation model: github-copilot\/claude-sonnet-4\.6/);
  assert.match(message, /No tickets were started/);
  assert.match(message, /- claude-sonnet-4\.5/);
});

test('ignores normal assistant text during preflight', () => {
  assert.equal(detectPreflightFailureReason(['AFK model availability preflight. Reply OK.', 'OK']), null);
});

test('detects concrete provider failures during preflight', () => {
  assert.equal(
    detectPreflightFailureReason(['thinking', 'The requested model is not available for integrator "copilot-language-server".']),
    'The requested model is not available for integrator "copilot-language-server".',
  );
});

test('classifies path-not-found failures', () => {
  const classification = classifyProviderFailure('Tool failed: ENOENT: no such file or directory, open \"/tmp/missing.md\"');
  assert.equal(classification?.kind, 'path-not-found');
});

test('classifies patch-context-mismatch failures', () => {
  const classification = classifyProviderFailure('apply_patch verification failed: Failed to find expected lines in src/example.ts (context mismatch)');
  assert.equal(classification?.kind, 'patch-context-mismatch');
});

test('classifies missing dependency failures', () => {
  const classification = classifyProviderFailure('PHP Warning: require(vendor/autoload.php): Failed to open stream: No such file or directory');
  assert.equal(classification?.kind, 'dependency-missing');
});

test('classifies stale opencode sessions', () => {
  const classification = classifyProviderFailure('opencode session stale after 3 recovery attempts');
  assert.equal(classification?.kind, 'opencode-session-stale');
});
