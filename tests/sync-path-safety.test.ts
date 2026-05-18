import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AssetSyncEngine } from '../src/sync/engine.js';

test('rejects destination escapes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'afk-safety-'));
  const src = path.join(root, 'src');
  const base = path.join(root, 'allowed');
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, 'a.md'), '# A');
  const badEngine = new AssetSyncEngine({ id: 'test', assetCategories: () => [{ name: 'docs', sourceRoot: src, destinationRoot: path.join(root, '..', 'escape'), destinationBase: base, extensions: ['.md'] }] });
  await assert.rejects(() => badEngine.plan(), /escapes root/);
});
