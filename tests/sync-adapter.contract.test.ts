import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ClaudeCodeSyncAdapter } from '../src/sync/adapters/claude-code.js';
import { CodexSyncAdapter } from '../src/sync/adapters/codex.js';
import { KimiCodeSyncAdapter } from '../src/sync/adapters/kimi-code.js';
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

test('to-linear skill is a syncable Linear planning artifact', async () => {
  const content = await readFile('artifacts/skills/to-linear.md', 'utf8');

  assert.match(content, /name: to-linear/);
  assert.match(content, /This skill uses Linear/);
  assert.match(content, /does not write Local Markdown scratch packages/);
  assert.match(content, /afk linear-plan/);
  assert.match(content, /Do not call Linear GraphQL/);
});

test('to-scratch remains local markdown only', async () => {
  const content = await readFile('artifacts/skills/to-scratch.md', 'utf8');

  assert.match(content, /name: to-scratch/);
  assert.match(content, /Local Markdown only/);
  assert.doesNotMatch(content, /afk linear-plan/);
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

test('kimi-code adapter provides mappings without hard-coded core paths', () => {
  const categories = KimiCodeSyncAdapter.assetCategories();
  assert.equal(categories.length, 1);
  assert.deepEqual(
    categories.map((c) => path.basename(c.destinationRoot)),
    ['skills'],
  );
  assert.deepEqual(
    categories.map((c) => c.destinationBase),
    categories.map((c) => path.dirname(c.destinationRoot)),
  );
});

test('kimi-code sync report renders reviewable counts and actions', () => {
  const output = formatSyncReport({
    adapterId: 'kimi-code',
    counts: { created: 1, updated: 0, unchanged: 0, skipped: 0 },
    actions: [
      {
        category: 'skills',
        sourcePath: 'artifacts/skills/a.md',
        destinationPath: '~/.kimi-code/skills/a/SKILL.md',
        status: 'created',
      },
    ],
  });

  assert.match(output, /Adapter: kimi-code/);
  assert.match(output, /Created: 1/);
  assert.match(output, /CREATED skills: artifacts\/skills\/a\.md -> ~\/\.kimi-code\/skills\/a\/SKILL\.md/);
});

test('codex adapter maps skills into user-level skill directories', () => {
  const categories = CodexSyncAdapter.assetCategories();
  assert.equal(categories.length, 1);
  const [skills] = categories;
  assert.equal(skills.name, 'skills');
  assert.equal(path.basename(skills.destinationRoot), 'skills');
  assert.equal(path.basename(path.dirname(skills.destinationRoot)), '.agents');
  assert.equal(skills.destinationBase, skills.destinationRoot);
  assert.equal(
    skills.mapDestination?.('afk-summary.md', skills.destinationRoot),
    path.join(skills.destinationRoot, 'afk-summary', 'SKILL.md'),
  );
});

test('codex adapter maps every vendored AFK skill to SKILL.md', async () => {
  const [skills] = CodexSyncAdapter.assetCategories();
  const skillFiles = (await readdir('artifacts/skills')).filter((file) => file.endsWith('.md'));
  assert.ok(skillFiles.length > 0);

  for (const file of skillFiles) {
    const skillName = path.basename(file, '.md');
    assert.equal(
      skills.mapDestination?.(file, skills.destinationRoot),
      path.join(skills.destinationRoot, skillName, 'SKILL.md'),
    );
  }
});

test('codex sync report renders reviewable counts and actions', () => {
  const output = formatSyncReport({
    adapterId: 'codex',
    counts: { created: 1, updated: 0, unchanged: 0, skipped: 0 },
    actions: [
      {
        category: 'skills',
        sourcePath: 'artifacts/skills/afk-summary.md',
        destinationPath: '~/.agents/skills/afk-summary/SKILL.md',
        status: 'created',
      },
    ],
  });

  assert.match(output, /Adapter: codex/);
  assert.match(output, /Created: 1/);
  assert.match(
    output,
    /CREATED skills: artifacts\/skills\/afk-summary\.md -> ~\/\.agents\/skills\/afk-summary\/SKILL\.md/,
  );
});
