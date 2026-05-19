import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';
import { OpenCodeSyncAdapter } from '../src/sync/adapters/opencode.js';
import { formatSyncReport } from '../src/sync/engine.js';

test('adapter provides mappings without hard-coded core paths', () => {
  const categories = OpenCodeSyncAdapter.assetCategories();
  assert.equal(categories.length, 3);
  assert.deepEqual(categories.map((c) => c.destinationRoot), ['private_dot_config/opencode/agents', 'private_dot_config/opencode/prompts', 'private_dot_config/opencode/command']);
});

test('sync report renders reviewable counts and actions', () => {
  const output = formatSyncReport({
    adapterId: 'opencode',
    counts: { created: 1, updated: 2, unchanged: 3, skipped: 4 },
    actions: [
      { category: 'agents', sourcePath: 'artifacts/opencode/agents/a.md', destinationPath: 'private_dot_config/opencode/agents/a.md', status: 'created' },
      { category: 'prompts', sourcePath: 'artifacts/opencode/prompts/b.md', destinationPath: 'private_dot_config/opencode/prompts/b.md', status: 'updated' },
    ],
  });

  assert.match(output, /Adapter: opencode/);
  assert.match(output, /Created: 1/);
  assert.match(output, /UPDATED prompts: artifacts\/opencode\/prompts\/b\.md -> private_dot_config\/opencode\/prompts\/b\.md/);
});

test('internal AFK prompt is not a syncable opencode artifact', async () => {
  await assert.rejects(access('artifacts/opencode/prompts/afk-prompt.md'));
  await assert.doesNotReject(access('src/prompts/afk-prompt.md'));
});

test('interview-me agent is a syncable opencode artifact', async () => {
  await assert.doesNotReject(access('artifacts/opencode/agents/interview-me.md'));
  await assert.doesNotReject(access('private_dot_config/opencode/agents/interview-me.md'));
});
