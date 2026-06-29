import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverGithubPrTemplates } from '../src/github-pr-template-discovery.js';

function createRepo(): string {
  return mkdtempSync(path.join(tmpdir(), 'afk-pr-template-'));
}

function writeRepoFile(repoRoot: string, repoRelativePath: string, content: string): void {
  const filePath = path.join(repoRoot, repoRelativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}

test('selects the first GitHub PR template by deterministic priority', () => {
  const repoRoot = createRepo();
  writeRepoFile(repoRoot, '.github/pull_request_template.md', 'lowercase github template');
  writeRepoFile(repoRoot, '.github/PULL_REQUEST_TEMPLATE.md', 'uppercase github template');
  writeRepoFile(repoRoot, 'docs/pull_request_template.md', 'docs template');

  const result = discoverGithubPrTemplates(repoRoot);

  assert.equal(result.kind, 'selected');
  assert.equal(result.path, '.github/pull_request_template.md');
  assert.equal(result.content, 'lowercase github template');
  assert.deepEqual(result.candidatePaths, ['.github/pull_request_template.md']);
});

test('selects uppercase GitHub PR template when lowercase file is missing', () => {
  const repoRoot = createRepo();
  writeRepoFile(repoRoot, '.github/PULL_REQUEST_TEMPLATE.md', 'uppercase github template');

  const result = discoverGithubPrTemplates(repoRoot);

  assert.equal(result.kind, 'selected');
  assert.equal(result.path, '.github/PULL_REQUEST_TEMPLATE.md');
  assert.equal(result.content, 'uppercase github template');
});

test('returns no-template result when templates are missing', () => {
  const result = discoverGithubPrTemplates(createRepo());

  assert.deepEqual(result, { kind: 'none', candidatePaths: [] });
});

test('selects docs and root templates in priority order', () => {
  const repoRoot = createRepo();
  writeRepoFile(repoRoot, 'docs/pull_request_template.md', 'lowercase docs template');
  writeRepoFile(repoRoot, 'docs/PULL_REQUEST_TEMPLATE.md', 'uppercase docs template');
  writeRepoFile(repoRoot, 'PULL_REQUEST_TEMPLATE.md', 'root template');

  const result = discoverGithubPrTemplates(repoRoot);

  assert.equal(result.kind, 'selected');
  assert.equal(result.path, 'docs/pull_request_template.md');
  assert.equal(result.content, 'lowercase docs template');
});

test('selects root PR template after higher-priority locations are absent', () => {
  const repoRoot = createRepo();
  writeRepoFile(repoRoot, 'PULL_REQUEST_TEMPLATE.md', 'root template');

  const result = discoverGithubPrTemplates(repoRoot);

  assert.equal(result.kind, 'selected');
  assert.equal(result.path, 'PULL_REQUEST_TEMPLATE.md');
  assert.equal(result.content, 'root template');
});

test('returns no-template result for unreadable template paths', () => {
  const repoRoot = createRepo();
  mkdirSync(path.join(repoRoot, '.github/pull_request_template.md'), { recursive: true });

  const result = discoverGithubPrTemplates(repoRoot);

  assert.deepEqual(result, { kind: 'none', candidatePaths: [] });
});

test('returns all directory PR template candidates without selecting one', () => {
  const repoRoot = createRepo();
  writeRepoFile(repoRoot, '.github/PULL_REQUEST_TEMPLATE/feature.md', 'feature template');
  writeRepoFile(repoRoot, '.github/PULL_REQUEST_TEMPLATE/bug.md', 'bug template');
  writeRepoFile(repoRoot, '.github/PULL_REQUEST_TEMPLATE/notes.txt', 'ignored');
  writeRepoFile(repoRoot, 'docs/pull_request_template.md', 'lower priority template');

  const result = discoverGithubPrTemplates(repoRoot);

  assert.equal(result.kind, 'multiple');
  assert.deepEqual(result.candidatePaths, [
    '.github/PULL_REQUEST_TEMPLATE/bug.md',
    '.github/PULL_REQUEST_TEMPLATE/feature.md',
  ]);
});
