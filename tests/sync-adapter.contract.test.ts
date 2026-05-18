import assert from 'node:assert/strict';
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
      { category: 'sub-agents', sourcePath: 'PRDs/sub-agents/a.md', destinationPath: 'private_dot_config/opencode/agents/a.md', status: 'created' },
      { category: 'prompts', sourcePath: 'PRDs/prompts/b.md', destinationPath: 'private_dot_config/opencode/prompts/b.md', status: 'updated' },
    ],
  });

  assert.match(output, /Adapter: opencode/);
  assert.match(output, /Created: 1/);
  assert.match(output, /UPDATED prompts: PRDs\/prompts\/b\.md -> private_dot_config\/opencode\/prompts\/b\.md/);
});
