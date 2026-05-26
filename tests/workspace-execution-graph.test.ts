import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  orderSelectedFeaturesByWaves,
  parseFeatureDependencies,
  refreshWorkspaceExecutionGraph,
} from '../src/workspace-execution-graph.js';

function writeFeature(repoRoot: string, feature: string, prd: string, issueStatus = 'done'): void {
  const featureDir = path.join(repoRoot, '.scratch', feature);
  mkdirSync(path.join(featureDir, 'issues'), { recursive: true });
  writeFileSync(path.join(featureDir, 'PRD.md'), prd);
  writeFileSync(
    path.join(featureDir, 'issues', '01.md'),
    `---\nfeature: ${feature}\nstatus: ${issueStatus}\nexecutor: afk\n---\n`,
  );
}

test('parses Depends-On-Features from PRD frontmatter', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-workspace-'));
  writeFeature(repoRoot, 'child', '---\nDepends-On-Features:\n  - parent\n---\n');
  assert.deepEqual(parseFeatureDependencies(repoRoot, 'child'), ['parent']);
});

test('ignores self references in Depends-On-Features frontmatter', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-workspace-'));
  writeFeature(repoRoot, 'child', '---\nDepends-On-Features:\n  - child\n---\n');
  assert.deepEqual(parseFeatureDependencies(repoRoot, 'child'), []);
});

test('rejects PRDs with more than one Depends-On-Features entry', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-workspace-'));
  writeFeature(repoRoot, 'child', '---\nDepends-On-Features:\n  - parent1\n  - parent2\n---\n');
  assert.throws(
    () => parseFeatureDependencies(repoRoot, 'child'),
    /Feature child: PRD frontmatter Depends-On-Features supports at most one entry\. Found 2\./,
  );
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

test('orders selected features by dependency waves', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-workspace-'));
  writeFeature(repoRoot, 'parent', '# PRD\n');
  writeFeature(repoRoot, 'child', '---\nDepends-On-Features:\n  - parent\n---\n');
  const graph = refreshWorkspaceExecutionGraph(repoRoot, ['child', 'parent'], 4);

  assert.deepEqual(orderSelectedFeaturesByWaves(graph), ['parent', 'child']);
});

test('marks selected downstream as blocked when upstream is incomplete and unselected', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-workspace-'));
  writeFeature(repoRoot, 'parent', '# PRD\n', 'ready-for-agent');
  writeFeature(repoRoot, 'child', '---\nDepends-On-Features:\n  - parent\n---\n', 'ready-for-agent');

  const graph = refreshWorkspaceExecutionGraph(repoRoot, ['child'], 3);
  assert.equal(graph.features.child.state, 'blocked');
  assert.deepEqual(graph.features.child.blockedByFeatures, ['parent']);
  assert.match(graph.features.child.blockedReason ?? '', /incomplete unselected upstream feature\(s\): parent/);
});

test('linear stacked features are ready when upstream is selected', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-workspace-'));
  writeFeature(repoRoot, 'parent', '# PRD\n', 'ready-for-agent');
  writeFeature(repoRoot, 'child', '---\nDepends-On-Features:\n  - parent\n---\n', 'ready-for-agent');
  const graph = refreshWorkspaceExecutionGraph(repoRoot, ['parent', 'child'], 3);

  assert.equal(graph.features.parent.state, 'ready');
  assert.equal(graph.features.child.state, 'ready');
  assert.deepEqual(graph.featureWaves, [['parent'], ['child']]);
  assert.equal(graph.features.child.stackParent, 'parent');
});

test('independent features have no cross-feature blocking', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-workspace-'));
  writeFeature(repoRoot, 'feat-a', '# PRD\n', 'ready-for-agent');
  writeFeature(repoRoot, 'feat-b', '# PRD\n', 'ready-for-agent');
  const graph = refreshWorkspaceExecutionGraph(repoRoot, ['feat-a', 'feat-b'], 3);

  assert.equal(graph.features['feat-a'].state, 'ready');
  assert.equal(graph.features['feat-b'].state, 'ready');
  assert.deepEqual(graph.features['feat-a'].blockedByFeatures, []);
  assert.deepEqual(graph.features['feat-b'].blockedByFeatures, []);
  assert.deepEqual(graph.featureWaves, [['feat-a', 'feat-b']]);
});

test('surfaces >1 Depends-On-Features error through refreshWorkspaceExecutionGraph', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-workspace-'));
  writeFeature(repoRoot, 'parent1', '# PRD\n', 'ready-for-agent');
  writeFeature(repoRoot, 'parent2', '# PRD\n', 'ready-for-agent');
  writeFeature(repoRoot, 'child', '---\nDepends-On-Features:\n  - parent1\n  - parent2\n---\n', 'ready-for-agent');
  assert.throws(
    () => refreshWorkspaceExecutionGraph(repoRoot, ['parent1', 'parent2', 'child'], 3),
    /Feature child: PRD frontmatter Depends-On-Features supports at most one entry\. Found 2\./,
  );
});
