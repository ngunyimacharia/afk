import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createDefaultTrackerProvider, ScratchTrackerProvider } from '../src/scratch-tracker-provider.js';

function makeRepo(): { repoRoot: string; issuesDir: string } {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  return { repoRoot, issuesDir };
}

test('scratch provider is the default tracker provider', () => {
  const { repoRoot } = makeRepo();
  const provider = createDefaultTrackerProvider(repoRoot);

  assert.equal(provider.kind, 'scratch');
});

test('scratch provider preserves ticket repository discovery fields and eligibility', async () => {
  const { repoRoot, issuesDir } = makeRepo();
  writeFileSync(
    path.join(issuesDir, '01.md'),
    '---\nfeature: feat\nstatus: waiting\nexecutor: afk\nDepends-On:\n  - "00"\n---\n\n# Body\n',
  );
  const provider = new ScratchTrackerProvider(repoRoot);

  const [item] = await provider.list();

  assert.equal(item.feature, 'feat');
  assert.equal(item.issueName, '01');
  assert.equal(item.label, 'feat/01');
  assert.equal(item.status, 'waiting');
  assert.equal(item.executorAfk, true);
  assert.deepEqual(item.dependsOn, ['00']);
  assert.equal(provider.isEligible(item), true);
});

test('scratch materialization returns the original markdown issue path', async () => {
  const { repoRoot, issuesDir } = makeRepo();
  const ticketPath = path.join(issuesDir, '01.md');
  writeFileSync(ticketPath, '---\nstatus: ready-for-agent\n---\n');
  const provider = new ScratchTrackerProvider(repoRoot);

  const files = await provider.materialize({ provider: 'scratch', id: 'feat/01' });

  assert.equal(files.ticketPath, ticketPath);
  assert.equal(files.scratchFeaturePath, path.join(repoRoot, '.scratch', 'feat'));
});

test('scratch provider keeps repository metadata validation errors intact', async () => {
  const { repoRoot, issuesDir } = makeRepo();
  writeFileSync(path.join(issuesDir, '01.md'), 'Status: ready-for-agent\n');
  const provider = new ScratchTrackerProvider(repoRoot);

  await assert.rejects(() => provider.list(), /legacy Status line/);
});
