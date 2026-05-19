import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseFeatureDependencies, refreshWorkspaceExecutionGraph } from '../src/workspace-execution-graph.js';

function writeFeature(repoRoot: string, feature: string, prd: string, issueStatus = 'done'): void {
  const featureDir = path.join(repoRoot, '.scratch', feature);
  mkdirSync(path.join(featureDir, 'issues'), { recursive: true });
  writeFileSync(path.join(featureDir, 'PRD.md'), prd);
  writeFileSync(path.join(featureDir, 'issues', '01.md'), `---\nfeature: ${feature}\nstatus: ${issueStatus}\nexecutor: afk\n---\n`);
}

test('parses Depends-On-Features from PRD frontmatter', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-workspace-'));
  writeFeature(repoRoot, 'child', '---\nDepends-On-Features:\n  - parent\n---\n');
  assert.deepEqual(parseFeatureDependencies(repoRoot, 'child'), ['parent']);
});

test('writes workspace execution graph with feature waves', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-workspace-'));
  writeFeature(repoRoot, 'parent', '# PRD\n');
  writeFeature(repoRoot, 'child', '---\nDepends-On-Features:\n  - parent\n---\n');
  const graph = refreshWorkspaceExecutionGraph(repoRoot, ['parent', 'child'], 4);

  assert.deepEqual(graph.featureWaves, [['parent'], ['child']]);
  assert.equal(graph.concurrency, 4);
  assert.equal(graph.features.child.stackParent, 'parent');
  assert.match(readFileSync(path.join(repoRoot, '.scratch', 'execution.json'), 'utf8'), /"selectedFeatures"/);
});

test('errors when selected downstream depends on incomplete unselected upstream', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-workspace-'));
  writeFeature(repoRoot, 'parent', '# PRD\n', 'ready-for-agent');
  writeFeature(repoRoot, 'child', '---\nDepends-On-Features:\n  - parent\n---\n');

  assert.throws(() => refreshWorkspaceExecutionGraph(repoRoot, ['child'], 3), /incomplete unselected upstream feature parent/);
});
