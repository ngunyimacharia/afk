import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { displayNameForProvider, readRunMetadata } from '../src/cli.js';

test('displayNameForProvider maps current provider names', () => {
  assert.equal(displayNameForProvider('opencode'), 'OpenCode');
  assert.equal(displayNameForProvider('claude'), 'Claude');
  assert.equal(displayNameForProvider('codex'), 'Codex');
  assert.equal(displayNameForProvider('unknown'), 'unknown');
});

test('readRunMetadata migrates legacy claude-kimi provider to Claude display name', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-cli-metadata-'));
  const metadataRoot = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata');
  mkdirSync(metadataRoot, { recursive: true });

  const runId = 'run-123';
  writeFileSync(
    path.join(metadataRoot, 'feat-001.json'),
    JSON.stringify({
      RUN_ID: runId,
      EXECUTION_MODEL_ID: 'kimi/kimi-for-coding',
      EXECUTION_PROVIDER: 'claude-kimi',
    }),
    'utf8',
  );

  const metadata = readRunMetadata(repoRoot, runId);
  assert.equal(metadata.modelId, 'kimi/kimi-for-coding');
  assert.equal(metadata.harness, 'Claude');
  assert.equal(metadata.ticketCount, 1);
});
