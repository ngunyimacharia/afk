import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ClaudeCodeSyncAdapter } from '../src/sync/adapters/claude-code.js';
import { KimiSyncAdapter } from '../src/sync/adapters/kimi.js';
import { OpenCodeSyncAdapter } from '../src/sync/adapters/opencode.js';
import { formatSyncReport } from '../src/sync/engine.js';

test('adapter provides mappings without hard-coded core paths', () => {
  const categories = OpenCodeSyncAdapter.assetCategories();
  assert.equal(categories.length, 2);
  assert.deepEqual(
    categories.map((c) => path.basename(c.destinationRoot)),
    ['skills', 'prompts'],
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
        category: 'skills',
        sourcePath: 'artifacts/skills/a.md',
        destinationPath: '~/.config/opencode/skills/a.md',
        status: 'created',
      },
      {
        category: 'prompts',
        sourcePath: 'artifacts/prompts/b.md',
        destinationPath: '~/.config/opencode/prompts/b.md',
        status: 'updated',
      },
    ],
  });

  assert.match(output, /Adapter: opencode/);
  assert.match(output, /Created: 1/);
  assert.match(output, /UPDATED prompts: artifacts\/prompts\/b\.md -> ~\/\.config\/opencode\/prompts\/b\.md/);
});

test('internal AFK prompt is not a syncable opencode artifact', async () => {
  await assert.rejects(access('artifacts/prompts/afk-prompt.md'));
  await assert.doesNotReject(access('src/prompts/afk-prompt.md'));
});

test('interview-me skill is a syncable artifact', async () => {
  await assert.doesNotReject(access('artifacts/skills/interview-me.md'));
});

test('afk-config skill is a syncable artifact', async () => {
  await assert.doesNotReject(access('artifacts/skills/afk-config.md'));
});

test('kimi adapter provides mappings without hard-coded core paths', () => {
  const categories = KimiSyncAdapter.assetCategories();
  assert.equal(categories.length, 2);
  assert.deepEqual(
    categories.map((c) => path.basename(c.destinationRoot)),
    ['skills', 'prompts'],
  );
  assert.deepEqual(
    categories.map((c) => c.destinationBase),
    categories.map((c) => path.dirname(c.destinationRoot)),
  );
});

test('kimi sync report renders reviewable counts and actions', () => {
  const output = formatSyncReport({
    adapterId: 'kimi',
    counts: { created: 1, updated: 2, unchanged: 3, skipped: 4 },
    actions: [
      {
        category: 'skills',
        sourcePath: 'artifacts/skills/a.md',
        destinationPath: '~/.kimi/skills/a.md',
        status: 'created',
      },
      {
        category: 'prompts',
        sourcePath: 'artifacts/prompts/b.md',
        destinationPath: '~/.kimi/prompts/b.md',
        status: 'updated',
      },
    ],
  });

  assert.match(output, /Adapter: kimi/);
  assert.match(output, /Created: 1/);
  assert.match(output, /UPDATED prompts: artifacts\/prompts\/b\.md -> ~\/\.kimi\/prompts\/b\.md/);
});

test('claude-code adapter provides mappings without hard-coded core paths', () => {
  const categories = ClaudeCodeSyncAdapter.assetCategories();
  assert.equal(categories.length, 2);
  assert.deepEqual(
    categories.map((c) => path.basename(c.destinationRoot)),
    ['skills', 'prompts'],
  );
  assert.deepEqual(
    categories.map((c) => c.destinationBase),
    categories.map((c) => path.dirname(c.destinationRoot)),
  );
});

test('claude-code sync report renders reviewable counts and actions', () => {
  const output = formatSyncReport({
    adapterId: 'claude-code',
    counts: { created: 1, updated: 2, unchanged: 3, skipped: 4 },
    actions: [
      {
        category: 'skills',
        sourcePath: 'artifacts/skills/a.md',
        destinationPath: '~/.claude/skills/a/SKILL.md',
        status: 'created',
      },
      {
        category: 'prompts',
        sourcePath: 'artifacts/prompts/b.md',
        destinationPath: '~/.claude/prompts/b.md',
        status: 'updated',
      },
    ],
  });

  assert.match(output, /Adapter: claude-code/);
  assert.match(output, /Created: 1/);
  assert.match(output, /UPDATED prompts: artifacts\/prompts\/b\.md -> ~\/\.claude\/prompts\/b\.md/);
});
