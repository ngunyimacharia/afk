import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { formatManualPermissionReviewLines, runAfk } from '../src/cli.js';
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

test('manual permission summary renders deterministic detailed rows', () => {
  const lines = formatManualPermissionReviewLines([
    {
      order: 1,
      recordedAt: '2026-01-01T00:00:00.000Z',
      request: { sessionId: 'session-1', permissionId: 'perm-1', type: 'bash', title: 'run tests', patterns: ['bun test'] },
      metadata: {
        ticketLabel: 'feat/01',
        sessionId: 'session-1',
        permissionId: 'perm-1',
        type: 'bash',
        title: 'run tests',
        patterns: ['bun test'],
        queuedCount: 0,
      },
      decision: 'once',
    },
    {
      order: 2,
      recordedAt: '2026-01-01T00:00:01.000Z',
      request: { sessionId: 'session-2', permissionId: 'perm-2', type: 'edit', title: 'edit file', patterns: [] },
      metadata: {
        ticketLabel: 'feat/02',
        sessionId: 'session-2',
        permissionId: 'perm-2',
        type: 'edit',
        title: 'edit file',
        patterns: [],
        queuedCount: 0,
      },
      decision: 'reject',
      safeDefaultReason: 'prompt-cancelled',
    },
  ]);

  assert.equal(lines[0], 'Manual permission review summary:');
  assert.match(lines[1] ?? '', /#1 \| ticket=feat\/01 \| session=session-1 \| permission=perm-1/);
  assert.match(lines[1] ?? '', /patterns=bun test \| decision=once \| recordedAt=2026-01-01T00:00:00.000Z/);
  assert.match(lines[2] ?? '', /#2 \| ticket=feat\/02 \| session=session-2 \| permission=perm-2/);
  assert.match(lines[2] ?? '', /patterns=none \| decision=reject \(prompt-cancelled\) \| recordedAt=2026-01-01T00:00:01.000Z/);
});

test('manual permission summary reports no reviewed permissions when empty', () => {
  assert.deepEqual(formatManualPermissionReviewLines([]), ['Manual permission review: none required.']);
});
