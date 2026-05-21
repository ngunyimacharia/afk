import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FeatureExecutionRefreshService } from '../src/feature-execution-refresh.js';

test('refresh creates execution json and preserves current running state', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-refresh-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(path.join(issuesDir, '01.md'), '---\nfeature: feat\nstatus: ready-for-agent\n---\n');

  const service = new FeatureExecutionRefreshService(repoRoot);
  const graph = service.refresh('feat', { runningIssues: ['01'] });

  assert.equal(graph.tickets['01'].state, 'running');
  assert.match(readFileSync(path.join(repoRoot, '.scratch', 'feat', 'execution.json'), 'utf8'), /"state": "running"/);
});

test('refresh recomputes dependency state after status changes', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-refresh-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  const first = path.join(issuesDir, '01.md');
  writeFileSync(first, '---\nfeature: feat\nstatus: ready-for-agent\n---\n');
  writeFileSync(
    path.join(issuesDir, '02.md'),
    '---\nfeature: feat\nstatus: ready-for-agent\nDepends-On:\n  - 01\n---\n',
  );

  const service = new FeatureExecutionRefreshService(repoRoot);
  assert.equal(service.refresh('feat').tickets['02'].state, 'blocked');
  writeFileSync(first, '---\nfeature: feat\nstatus: done\n---\n');
  assert.equal(service.refresh('feat').tickets['02'].state, 'ready');
});
