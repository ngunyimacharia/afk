import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AssetSyncEngine } from '../src/sync/engine.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'afk-sync-'));
  const src = path.join(root, 'src');
  const dst = path.join(root, 'dst');
  await mkdir(src, { recursive: true });
  await mkdir(dst, { recursive: true });
  return { root, src, dst };
}

test('discovers, validates, and classifies assets', async () => {
  const { src, dst } = await fixture();
  await writeFile(path.join(src, 'a.md'), '# A');
  await writeFile(path.join(src, 'b.txt'), 'nope');
  await writeFile(path.join(dst, 'a.md'), '# old');

  const engine = new AssetSyncEngine({
    id: 'test',
    assetCategories: () => [
      {
        name: 'docs',
        sourceRoot: src,
        destinationRoot: dst,
        extensions: ['.md'],
        validateSource: async (p) => {
          if (!p.endsWith('.md')) throw new Error('bad');
        },
      },
    ],
  });

  const report = await engine.execute();
  assert.equal(report.counts.updated, 1);
  assert.equal(report.counts.skipped, 1);
  assert.equal(await readFile(path.join(dst, 'a.md'), 'utf8'), '# A');
});

test('creates missing destination directories', async () => {
  const { src, dst } = await fixture();
  await writeFile(path.join(src, 'a.md'), '# A');
  const nestedDst = path.join(dst, 'nested', 'tree');
  const engine = new AssetSyncEngine({
    id: 'test',
    assetCategories: () => [{ name: 'docs', sourceRoot: src, destinationRoot: nestedDst, extensions: ['.md'] }],
  });
  const report = await engine.execute();
  assert.equal(report.counts.created, 1);
  assert.equal(await readFile(path.join(nestedDst, 'a.md'), 'utf8'), '# A');
});

test('ignores missing source directories', async () => {
  const { root, dst } = await fixture();
  const missingSrc = path.join(root, 'missing');
  const engine = new AssetSyncEngine({
    id: 'test',
    assetCategories: () => [{ name: 'docs', sourceRoot: missingSrc, destinationRoot: dst, extensions: ['.md'] }],
  });
  const report = await engine.execute();
  assert.deepEqual(report.counts, { created: 0, updated: 0, unchanged: 0, skipped: 0 });
  assert.deepEqual(report.actions, []);
});

test('leaves unchanged files untouched', async () => {
  const { src, dst } = await fixture();
  await writeFile(path.join(src, 'a.md'), '# A');
  await writeFile(path.join(dst, 'a.md'), '# A');
  const engine = new AssetSyncEngine({
    id: 'test',
    assetCategories: () => [{ name: 'docs', sourceRoot: src, destinationRoot: dst, extensions: ['.md'] }],
  });
  const report = await engine.plan();
  assert.equal(report.counts.unchanged, 1);
});

test('classifies changed destination content as updated', async () => {
  const { src, dst } = await fixture();
  await writeFile(path.join(src, 'a.md'), '# new');
  await writeFile(path.join(dst, 'a.md'), '# old');
  const engine = new AssetSyncEngine({
    id: 'test',
    assetCategories: () => [{ name: 'docs', sourceRoot: src, destinationRoot: dst, extensions: ['.md'] }],
  });
  const report = await engine.plan();
  assert.equal(report.counts.updated, 1);
});

test('reports skipped files outside configured extensions', async () => {
  const { src, dst } = await fixture();
  await writeFile(path.join(src, 'a.md'), '# A');
  await writeFile(path.join(src, 'b.txt'), 'nope');
  const engine = new AssetSyncEngine({
    id: 'test',
    assetCategories: () => [{ name: 'docs', sourceRoot: src, destinationRoot: dst, extensions: ['.md'] }],
  });
  const report = await engine.plan();
  assert.equal(report.counts.skipped, 1);
});

test('does not rewrite unchanged destination files', async () => {
  const { src, dst } = await fixture();
  await writeFile(path.join(src, 'a.md'), '# A');
  await writeFile(path.join(dst, 'a.md'), '# A');
  const before = await readFile(path.join(dst, 'a.md'), 'utf8');
  const engine = new AssetSyncEngine({
    id: 'test',
    assetCategories: () => [{ name: 'docs', sourceRoot: src, destinationRoot: dst, extensions: ['.md'] }],
  });
  const report = await engine.execute();
  assert.equal(report.counts.unchanged, 1);
  assert.equal(await readFile(path.join(dst, 'a.md'), 'utf8'), before);
});
