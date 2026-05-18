import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenCodeSyncAdapter } from '../src/sync/adapters/opencode.js';

test('adapter provides mappings without hard-coded core paths', () => {
  const categories = OpenCodeSyncAdapter.assetCategories();
  assert.equal(categories.length, 3);
  assert.deepEqual(categories.map((c) => c.destinationRoot), ['private_dot_config/opencode/agents', 'private_dot_config/opencode/prompts', 'private_dot_config/opencode/command']);
});
