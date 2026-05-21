import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { OpenCodeSyncAdapter } from '../src/sync/adapters/opencode.js';
import { formatSyncReport } from '../src/sync/engine.js';

test('adapter provides mappings without hard-coded core paths', () => {
  const categories = OpenCodeSyncAdapter.assetCategories();
  assert.equal(categories.length, 3);
  assert.deepEqual(
    categories.map((c) => path.basename(c.destinationRoot)),
    ['agents', 'prompts', 'command'],
  );
  assert.deepEqual(
    categories.map((c) => c.destinationBase),
    categories.map((c) => path.dirname(c.destinationRoot)),
  );
});

test('sync report renders reviewable counts and actions', () => {
  const output = formatSyncReport({
    adapterId: 'opencode',
    counts: { created: 1, updated: 2, unchanged: 3, skipped: 4 },
    actions: [
      {
        category: 'agents',
        sourcePath: 'artifacts/opencode/agents/a.md',
        destinationPath: '~/.config/opencode/agents/a.md',
        status: 'created',
      },
      {
        category: 'prompts',
        sourcePath: 'artifacts/opencode/prompts/b.md',
        destinationPath: '~/.config/opencode/prompts/b.md',
        status: 'updated',
      },
    ],
  });

  assert.match(output, /Adapter: opencode/);
  assert.match(output, /Created: 1/);
  assert.match(output, /UPDATED prompts: artifacts\/opencode\/prompts\/b\.md -> ~\/\.config\/opencode\/prompts\/b\.md/);
});

test('internal AFK prompt is not a syncable opencode artifact', async () => {
  await assert.rejects(access('artifacts/opencode/prompts/afk-prompt.md'));
  await assert.doesNotReject(access('src/prompts/afk-prompt.md'));
});

test('interview-me agent is a syncable opencode artifact', async () => {
  await assert.doesNotReject(access('artifacts/opencode/agents/interview-me.md'));
});

test('afk-config command is a syncable opencode slash command', async () => {
  await assert.doesNotReject(access('artifacts/opencode/commands/afk-config.md'));
});
