import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runAfk } from '../src/cli.js';
import { formatModelSelectionTitle, prioritizeModelChoices } from '../src/interactive-launch.js';

test('default afk launch fails early without interactive tty', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const result = await runAfk(repoRoot, {
    io: { stdin: { isTTY: false } as never, stdout: { isTTY: false } as never },
    env: { ...process.env, CI: '' },
  });
  assert.equal(result.code, 1);
  assert.match(result.message, /interactive terminal/i);
});

test('default afk launch fails early in ci mode', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const result = await runAfk(repoRoot, {
    io: { stdin: { isTTY: true } as never, stdout: { isTTY: true } as never },
    env: { ...process.env, CI: '1' },
  });
  assert.equal(result.code, 1);
  assert.match(result.message, /does not run in CI/i);
});

test('model selection title includes provider and model label', () => {
  assert.equal(
    formatModelSelectionTitle({ id: 'github-copilot/gpt-5.4-mini', label: 'GPT-5.4 Mini' }),
    'github-copilot - GPT-5.4 Mini',
  );
});

test('model selection title falls back to model id segment', () => {
  assert.equal(formatModelSelectionTitle({ id: 'openai/gpt-5.5' }), 'openai - gpt-5.5');
});

test('prioritizes preferred model choice when available', () => {
  const choices = prioritizeModelChoices(
    [
      { id: 'provider/first', label: 'First' },
      { id: 'provider/last', label: 'Last' },
    ],
    'provider/last',
  );

  assert.deepEqual(choices.map((choice) => choice.value), ['provider/last', 'provider/first']);
});

test('ignores stale preferred model choice', () => {
  const choices = prioritizeModelChoices(
    [
      { id: 'provider/first', label: 'First' },
      { id: 'provider/last', label: 'Last' },
    ],
    'provider/missing',
  );

  assert.deepEqual(choices.map((choice) => choice.value), ['provider/first', 'provider/last']);
});
