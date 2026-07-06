import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ClaudeCodeSyncAdapter } from '../src/sync/adapters/claude-code.js';
import { CodexSyncAdapter } from '../src/sync/adapters/codex.js';
import { KimiCodeSyncAdapter } from '../src/sync/adapters/kimi-code.js';
import { OpenCodeSyncAdapter } from '../src/sync/adapters/opencode.js';
import { AssetSyncEngine, formatSyncReport } from '../src/sync/engine.js';
import { SyncAdapters } from '../src/sync/runner.js';

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'afk-opencode-sync-'));
  const artifacts = path.join(root, 'artifacts');
  const opencode = path.join(root, '.config', 'opencode');
  await mkdir(path.join(artifacts, 'skills'), { recursive: true });
  await mkdir(path.join(artifacts, 'prompts'), { recursive: true });
  return { root, artifacts, opencode };
}

test('syncs initial opencode asset categories into the destination tree', async () => {
  const { artifacts, opencode } = await makeFixture();
  await writeFile(path.join(artifacts, 'skills', 'alpha.md'), '# alpha');
  await writeFile(path.join(artifacts, 'prompts', 'beta.md'), '# beta');

  const engine = new AssetSyncEngine({
    id: 'opencode',
    assetCategories: () =>
      OpenCodeSyncAdapter.assetCategories().map((category) => {
        const relativeSource = path.basename(category.sourceRoot);
        const relativeDestination = path.basename(category.destinationRoot);
        return {
          ...category,
          sourceRoot: path.join(artifacts, relativeSource),
          destinationRoot: path.join(opencode, relativeDestination),
          destinationBase: opencode,
        };
      }),
  });

  const first = await engine.execute();
  assert.equal(first.counts.created, 2);
  assert.equal(await readFile(path.join(opencode, 'skills', 'alpha', 'SKILL.md'), 'utf8'), '# alpha');
  assert.equal(await readFile(path.join(opencode, 'prompts', 'beta.md'), 'utf8'), '# beta');

  const second = await engine.execute();
  assert.equal(second.counts.unchanged, 2);
});

async function makeClaudeCodeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'afk-claude-code-sync-'));
  const artifacts = path.join(root, 'artifacts');
  const claudeCode = path.join(root, '.claude');
  await mkdir(path.join(artifacts, 'skills'), { recursive: true });
  await mkdir(path.join(artifacts, 'prompts'), { recursive: true });
  return { root, artifacts, claudeCode };
}

test('syncs initial claude-code asset categories into the destination tree', async () => {
  const { artifacts, claudeCode } = await makeClaudeCodeFixture();
  await writeFile(path.join(artifacts, 'skills', 'alpha.md'), '# alpha');
  await writeFile(path.join(artifacts, 'prompts', 'beta.md'), '# beta');

  const engine = new AssetSyncEngine({
    id: 'claude-code',
    assetCategories: () =>
      ClaudeCodeSyncAdapter.assetCategories().map((category) => {
        const relativeSource = path.basename(category.sourceRoot);
        const relativeDestination = path.basename(category.destinationRoot);
        return {
          ...category,
          sourceRoot: path.join(artifacts, relativeSource),
          destinationRoot: path.join(claudeCode, relativeDestination),
          destinationBase: claudeCode,
        };
      }),
  });

  const first = await engine.execute();
  assert.equal(first.counts.created, 2);
  assert.equal(await readFile(path.join(claudeCode, 'skills', 'alpha', 'SKILL.md'), 'utf8'), '# alpha');
  assert.equal(await readFile(path.join(claudeCode, 'prompts', 'beta.md'), 'utf8'), '# beta');

  const second = await engine.execute();
  assert.equal(second.counts.unchanged, 2);
});

test('sync report reminds the user to restart opencode', () => {
  const message = formatSyncReport({
    adapterId: 'opencode',
    counts: { created: 1, updated: 0, unchanged: 0, skipped: 0 },
    actions: [],
  });
  assert.match(message, /Adapter: opencode/);
});

async function makeKimiCodeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'afk-kimi-code-sync-'));
  const artifacts = path.join(root, 'artifacts');
  const kimiCode = path.join(root, '.kimi-code');
  await mkdir(path.join(artifacts, 'skills'), { recursive: true });
  return { root, artifacts, kimiCode };
}

test('syncs initial kimi-code asset categories into the destination tree', async () => {
  const { artifacts, kimiCode } = await makeKimiCodeFixture();
  await writeFile(path.join(artifacts, 'skills', 'alpha.md'), '# alpha');

  const engine = new AssetSyncEngine({
    id: 'kimi-code',
    assetCategories: () =>
      KimiCodeSyncAdapter.assetCategories().map((category) => {
        const relativeSource = path.basename(category.sourceRoot);
        const relativeDestination = path.basename(category.destinationRoot);
        return {
          ...category,
          sourceRoot: path.join(artifacts, relativeSource),
          destinationRoot: path.join(kimiCode, relativeDestination),
          destinationBase: kimiCode,
        };
      }),
  });

  const first = await engine.execute();
  assert.equal(first.counts.created, 1);
  assert.equal(await readFile(path.join(kimiCode, 'skills', 'alpha', 'SKILL.md'), 'utf8'), '# alpha');

  const second = await engine.execute();
  assert.equal(second.counts.unchanged, 1);
});

async function makeCodexFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'afk-codex-sync-'));
  const artifacts = path.join(root, 'artifacts');
  const codexSkills = path.join(root, '.agents', 'skills');
  await mkdir(path.join(artifacts, 'skills'), { recursive: true });
  return { root, artifacts, codexSkills };
}

test('syncs initial codex skills into the user skills tree', async () => {
  const { artifacts, codexSkills } = await makeCodexFixture();
  await writeFile(path.join(artifacts, 'skills', 'afk-summary.md'), '# summary');

  const engine = new AssetSyncEngine({
    id: 'codex',
    assetCategories: () =>
      CodexSyncAdapter.assetCategories().map((category) => ({
        ...category,
        sourceRoot: path.join(artifacts, path.basename(category.sourceRoot)),
        destinationRoot: codexSkills,
        destinationBase: codexSkills,
      })),
  });

  const first = await engine.execute();
  assert.equal(first.counts.created, 1);
  assert.equal(await readFile(path.join(codexSkills, 'afk-summary', 'SKILL.md'), 'utf8'), '# summary');

  const second = await engine.execute();
  assert.equal(second.counts.unchanged, 1);
});

test('sync runner includes codex and pi reports after existing adapters', () => {
  assert.deepEqual(
    SyncAdapters.map((adapter) => adapter.id),
    ['opencode', 'claude-code', 'kimi-code', 'codex', 'pi'],
  );
});
