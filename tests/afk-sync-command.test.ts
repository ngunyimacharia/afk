import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KimiSyncAdapter } from '../src/sync/adapters/kimi.js';
import { OpenCodeSyncAdapter } from '../src/sync/adapters/opencode.js';
import { AssetSyncEngine, formatSyncReport } from '../src/sync/engine.js';

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'afk-opencode-sync-'));
  const artifacts = path.join(root, 'artifacts', 'opencode');
  const opencode = path.join(root, '.config', 'opencode');
  await mkdir(path.join(artifacts, 'agents'), { recursive: true });
  await mkdir(path.join(artifacts, 'prompts'), { recursive: true });
  await mkdir(path.join(artifacts, 'commands'), { recursive: true });
  return { root, artifacts, opencode };
}

async function makeKimiFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'afk-kimi-sync-'));
  const artifacts = path.join(root, 'artifacts', 'kimi');
  const kimi = path.join(root, '.kimi');
  await mkdir(path.join(artifacts, 'skills'), { recursive: true });
  await mkdir(path.join(artifacts, 'prompts'), { recursive: true });
  return { root, artifacts, kimi };
}

test('syncs initial opencode asset categories into the destination tree', async () => {
  const { artifacts, opencode } = await makeFixture();
  await writeFile(path.join(artifacts, 'agents', 'alpha.md'), '# alpha');
  await writeFile(path.join(artifacts, 'prompts', 'beta.md'), '# beta');
  await writeFile(path.join(artifacts, 'commands', 'gamma.md'), '# gamma');

  const engine = new AssetSyncEngine({
    id: 'opencode',
    assetCategories: () =>
      OpenCodeSyncAdapter.assetCategories().map((category) => {
        const relativeSource = category.sourceRoot.replace('artifacts/opencode/', '');
        const relativeDestination = path.basename(category.destinationRoot);
        return {
          ...category,
          sourceRoot: path.join(artifacts, relativeSource),
          destinationRoot: path.join(opencode, relativeDestination === 'command' ? 'command' : relativeDestination),
          destinationBase: opencode,
        };
      }),
  });

  const first = await engine.execute();
  assert.equal(first.counts.created, 3);
  assert.equal(await readFile(path.join(opencode, 'agents', 'alpha.md'), 'utf8'), '# alpha');
  assert.equal(await readFile(path.join(opencode, 'prompts', 'beta.md'), 'utf8'), '# beta');
  assert.equal(await readFile(path.join(opencode, 'command', 'gamma.md'), 'utf8'), '# gamma');

  const second = await engine.execute();
  assert.equal(second.counts.unchanged, 3);
});

test('syncs initial kimi asset categories into the destination tree', async () => {
  const { artifacts, kimi } = await makeKimiFixture();
  await writeFile(path.join(artifacts, 'skills', 'alpha.md'), '# alpha');
  await writeFile(path.join(artifacts, 'prompts', 'beta.md'), '# beta');

  const engine = new AssetSyncEngine({
    id: 'kimi',
    assetCategories: () =>
      KimiSyncAdapter.assetCategories().map((category) => {
        const relativeSource = category.sourceRoot.replace('artifacts/kimi/', '');
        const relativeDestination = path.basename(category.destinationRoot);
        return {
          ...category,
          sourceRoot: path.join(artifacts, relativeSource),
          destinationRoot: path.join(kimi, relativeDestination),
          destinationBase: kimi,
        };
      }),
  });

  const first = await engine.execute();
  assert.equal(first.counts.created, 2);
  assert.equal(await readFile(path.join(kimi, 'skills', 'alpha.md'), 'utf8'), '# alpha');
  assert.equal(await readFile(path.join(kimi, 'prompts', 'beta.md'), 'utf8'), '# beta');

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
