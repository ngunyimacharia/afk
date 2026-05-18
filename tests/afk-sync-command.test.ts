import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AssetSyncEngine, formatSyncReport } from '../src/sync/engine.js';
import { OpenCodeSyncAdapter } from '../src/sync/adapters/opencode.js';

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'afk-opencode-sync-'));
  const prds = path.join(root, 'PRDs');
  const opencode = path.join(root, 'private_dot_config', 'opencode');
  await mkdir(path.join(prds, 'sub-agents'), { recursive: true });
  await mkdir(path.join(prds, 'prompts'), { recursive: true });
  await mkdir(path.join(prds, 'commands'), { recursive: true });
  return { root, prds, opencode };
}

test('syncs initial opencode asset categories into the destination tree', async () => {
  const { prds, opencode } = await makeFixture();
  await writeFile(path.join(prds, 'sub-agents', 'alpha.md'), '# alpha');
  await writeFile(path.join(prds, 'prompts', 'beta.md'), '# beta');
  await writeFile(path.join(prds, 'commands', 'gamma.md'), '# gamma');

  const engine = new AssetSyncEngine({
    id: 'opencode',
    assetCategories: () => OpenCodeSyncAdapter.assetCategories().map((category) => {
      const relativeSource = category.sourceRoot.replace('PRDs/', '');
      const relativeDestination = category.destinationRoot.replace('private_dot_config/opencode/', '');
      return {
        ...category,
        sourceRoot: path.join(prds, relativeSource),
        destinationRoot: path.join(opencode, relativeDestination),
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

test('sync report reminds the user to restart opencode', () => {
  const message = formatSyncReport({
    adapterId: 'opencode',
    counts: { created: 1, updated: 0, unchanged: 0, skipped: 0 },
    actions: [],
  });
  assert.match(message, /Adapter: opencode/);
});
