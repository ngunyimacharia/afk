import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexSyncAdapter } from '../src/sync/adapters/codex.js';
import { AssetSyncEngine } from '../src/sync/engine.js';

test('rejects destination escapes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'afk-safety-'));
  const src = path.join(root, 'src');
  const base = path.join(root, 'allowed');
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, 'a.md'), '# A');
  const badEngine = new AssetSyncEngine({
    id: 'test',
    assetCategories: () => [
      {
        name: 'docs',
        sourceRoot: src,
        destinationRoot: path.join(root, '..', 'escape'),
        destinationBase: base,
        extensions: ['.md'],
      },
    ],
  });
  await assert.rejects(() => badEngine.plan(), /escapes root/);
});

test('codex destinations cannot escape the user skills root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'afk-codex-safety-'));
  const sourceRoot = path.join(root, 'artifacts', 'skills');
  const skillsRoot = path.join(root, '.agents', 'skills');
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, 'afk-summary.md'), '# Summary');

  const [category] = CodexSyncAdapter.assetCategories();
  const engine = new AssetSyncEngine({
    id: 'codex',
    assetCategories: () => [
      {
        ...category,
        sourceRoot,
        destinationRoot: skillsRoot,
        destinationBase: skillsRoot,
        mapDestination: () => path.join(skillsRoot, '..', 'escaped', 'SKILL.md'),
      },
    ],
  });

  await assert.rejects(() => engine.plan(), /escapes root/);
});
