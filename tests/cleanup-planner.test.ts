import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CleanupPlanner } from '../src/cleanup.js';

test('classifies only terminal tickets for cleanup', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(path.join(issuesDir, 'done.md'), '---\nstatus: done\n---\n');
  writeFileSync(path.join(issuesDir, 'human.md'), '---\nstatus: ready-for-human\n---\n');
  writeFileSync(path.join(issuesDir, 'missing.md'), '# ticket\n');
  const planner = new CleanupPlanner({ repoRoot });
  const plan = planner.buildPlan();
  assert.deepEqual(plan.terminalTargets.map((item) => item.issuePath).length, 1);
  assert.match(plan.preservedIssues.join('\n'), /human\.md/);
  assert.match(plan.preservedIssues.join('\n'), /missing\.md/);
});

test('pairs terminal tickets with attributable runtime artifacts only', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  const logsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs');
  const metadataDir = path.join(logsDir, 'runtime-metadata');
  mkdirSync(issuesDir, { recursive: true });
  mkdirSync(metadataDir, { recursive: true });
  writeFileSync(path.join(issuesDir, 'done.md'), '---\nstatus: complete\n---\n');
  writeFileSync(path.join(logsDir, 'feat-done.log'), 'log');
  writeFileSync(path.join(metadataDir, 'feat-done.json'), '{}');
  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  assert.equal(plan.terminalTargets[0]?.logPath?.endsWith('feat-done.log'), true);
  assert.equal(plan.terminalTargets[0]?.metadataPath?.endsWith('feat-done.json'), true);
});

test('preserves handoff tickets with runtime metadata RUN_STATUS handoff', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  const logsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs');
  const metadataDir = path.join(logsDir, 'runtime-metadata');
  mkdirSync(issuesDir, { recursive: true });
  mkdirSync(metadataDir, { recursive: true });
  writeFileSync(path.join(issuesDir, 'handoff.md'), '---\nstatus: done\n---\n');
  writeFileSync(
    path.join(metadataDir, 'feat-handoff.json'),
    JSON.stringify({
      FEATURE_SLUG: 'feat',
      ISSUE_NAME: 'handoff',
      TICKET_PATH: path.join(issuesDir, 'handoff.md'),
      IMPLEMENTATION_STATUS: 'completed',
      REVIEW_STATUS: 'unavailable',
      RUN_STATUS: 'handoff',
    }),
  );
  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  assert.equal(plan.terminalTargets.length, 0);
  assert.equal(plan.preservedIssues.length, 1);
  assert.ok(plan.preservedIssues[0]?.endsWith('handoff.md'));
});

test('preserves implementation-complete review-unavailable via runtime metadata', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  const logsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs');
  const metadataDir = path.join(logsDir, 'runtime-metadata');
  mkdirSync(issuesDir, { recursive: true });
  mkdirSync(metadataDir, { recursive: true });
  writeFileSync(path.join(issuesDir, 'unavailable.md'), '---\nstatus: complete\n---\n');
  writeFileSync(
    path.join(metadataDir, 'feat-unavailable.json'),
    JSON.stringify({
      FEATURE_SLUG: 'feat',
      ISSUE_NAME: 'unavailable',
      TICKET_PATH: path.join(issuesDir, 'unavailable.md'),
      IMPLEMENTATION_STATUS: 'completed',
      REVIEW_STATUS: 'unavailable',
    }),
  );
  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  assert.equal(plan.terminalTargets.length, 0);
  assert.ok(plan.preservedIssues[0]?.endsWith('unavailable.md'));
});
