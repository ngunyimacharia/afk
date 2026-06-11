import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CleanupExecutor, CleanupPlanner } from '../src/cleanup.js';

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

test('plans local Linear mirrors and runtime artifacts for terminal runs', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const logsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs');
  const metadataDir = path.join(logsDir, 'runtime-metadata');
  const mirrorPath = path.join(logsDir, 'linear-mirrors', 'eng-1-eng-2.md');
  mkdirSync(metadataDir, { recursive: true });
  mkdirSync(path.dirname(mirrorPath), { recursive: true });
  writeFileSync(mirrorPath, 'Linear mirror\n');
  writeFileSync(path.join(logsDir, 'eng-1-eng-2.log'), 'log');
  writeFileSync(
    path.join(metadataDir, 'eng-1-eng-2.json'),
    JSON.stringify({
      TICKET_PATH: mirrorPath,
      FEATURE_SLUG: 'eng-1',
      ISSUE_NAME: 'eng-2',
      LOG_PATH: path.join(logsDir, 'eng-1-eng-2.log'),
      START_TIME: '2026-05-18T00:00:00.000Z',
      START_EPOCH: 1,
      DONE_SENTINEL_PATH: path.join(logsDir, 'sentinels', 'eng-1-eng-2.done'),
      FAILED_SENTINEL_PATH: path.join(logsDir, 'sentinels', 'eng-1-eng-2.failed'),
      STATUS: 'completed',
      RUN_STATUS: 'completed',
      EXECUTION_PROVIDER: 'opencode',
      PROVIDER_SESSION_ID: 'session-1',
      PROVIDER_SESSION_REMOVABLE: true,
      INSPECTION_PROVIDER: null,
      INSPECTION_TARGET_IDENTIFIER: null,
      UNSAFE_REASON: null,
      LINEAR_ISSUE_ID: 'issue-2',
      LINEAR_ISSUE_KEY: 'ENG-2',
      LINEAR_ISSUE_URL: 'https://linear.app/acme/issue/ENG-2/test',
      LINEAR_PARENT_KEY: 'ENG-1',
      LINEAR_MIRROR_PATH: mirrorPath,
      LINEAR_SYNC_STATUS: 'terminal-synced',
    }),
  );

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  assert.equal(plan.terminalTargets.length, 1);
  assert.equal(plan.terminalTargets[0]?.issuePath, mirrorPath);
  assert.equal(plan.terminalTargets[0]?.linearMirrorPath, mirrorPath);
  assert.equal(plan.terminalTargets[0]?.metadataPath?.endsWith('eng-1-eng-2.json'), true);
  assert.equal(plan.terminalTargets[0]?.logPath?.endsWith('eng-1-eng-2.log'), true);
});

test('accepts legacy Linear mirror path from TICKET_PATH only under mirror root', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const logsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs');
  const metadataDir = path.join(logsDir, 'runtime-metadata');
  const mirrorPath = path.join(logsDir, 'linear-mirrors', 'eng-1-eng-2.md');
  mkdirSync(metadataDir, { recursive: true });
  mkdirSync(path.dirname(mirrorPath), { recursive: true });
  writeFileSync(mirrorPath, 'Linear mirror\n');
  writeFileSync(
    path.join(metadataDir, 'eng-1-eng-2.json'),
    JSON.stringify({
      TICKET_PATH: mirrorPath,
      FEATURE_SLUG: 'eng-1',
      ISSUE_NAME: 'eng-2',
      LOG_PATH: path.join(logsDir, 'eng-1-eng-2.log'),
      STATUS: 'completed',
      RUN_STATUS: 'completed',
      LINEAR_ISSUE_KEY: 'ENG-2',
    }),
  );

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  assert.equal(plan.terminalTargets[0]?.issuePath, mirrorPath);
  assert.equal(plan.terminalTargets[0]?.linearMirrorPath, mirrorPath);
});

test('does not plan arbitrary Linear metadata paths for deletion', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const logsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs');
  const metadataDir = path.join(logsDir, 'runtime-metadata');
  const unrelatedPath = path.join(repoRoot, 'do-not-delete.md');
  mkdirSync(metadataDir, { recursive: true });
  writeFileSync(unrelatedPath, 'keep\n');
  writeFileSync(
    path.join(metadataDir, 'eng-1-eng-2.json'),
    JSON.stringify({
      TICKET_PATH: unrelatedPath,
      FEATURE_SLUG: 'eng-1',
      ISSUE_NAME: 'eng-2',
      LOG_PATH: path.join(logsDir, 'eng-1-eng-2.log'),
      STATUS: 'completed',
      RUN_STATUS: 'completed',
      LINEAR_ISSUE_KEY: 'ENG-2',
      LINEAR_MIRROR_PATH: unrelatedPath,
    }),
  );

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  assert.equal(plan.terminalTargets.length, 1);
  assert.equal(plan.terminalTargets[0]?.issuePath, undefined);
  assert.equal(plan.terminalTargets[0]?.linearMirrorPath, undefined);

  new CleanupExecutor().execute(plan, repoRoot);
  assert.equal(existsSync(unrelatedPath), true);
});

test('does not plan traversal-derived Linear runtime artifacts for deletion', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const logsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs');
  const metadataDir = path.join(logsDir, 'runtime-metadata');
  const victimDir = mkdtempSync(path.join(tmpdir(), 'afk-victim-'));
  const victimBase = path.join(victimDir, 'runtime');
  const issueName = 'artifact';
  const featureSlug = path.relative(logsDir, victimBase);
  const escapedLogPath = `${victimBase}-${issueName}.log`;
  mkdirSync(metadataDir, { recursive: true });
  writeFileSync(escapedLogPath, 'keep\n');
  writeFileSync(
    path.join(metadataDir, 'eng-1-eng-2.json'),
    JSON.stringify({
      FEATURE_SLUG: featureSlug,
      ISSUE_NAME: issueName,
      STATUS: 'completed',
      RUN_STATUS: 'completed',
      LINEAR_ISSUE_KEY: 'ENG-2',
    }),
  );

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  assert.equal(plan.terminalTargets.length, 1);
  assert.equal(plan.terminalTargets[0]?.logPath, undefined);
  assert.equal(plan.terminalTargets[0]?.doneSentinelPath, undefined);
  assert.equal(plan.terminalTargets[0]?.failedSentinelPath, undefined);
  assert.equal(plan.terminalTargets[0]?.handoffSentinelPath, undefined);

  new CleanupExecutor().execute(plan, repoRoot);
  assert.equal(existsSync(escapedLogPath), true);
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

test('includes pending failed post-merge cleanup items in plan', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const logsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs');
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    path.join(logsDir, 'pending-post-merge-cleanup.json'),
    `${JSON.stringify([
      {
        feature: 'feat',
        issueName: '001',
        branchName: 'afk/feat/001',
        worktreePath: '/tmp/worktree',
        featureWorktreePath: '/tmp/feature-worktree',
        featureBranchName: 'feat',
        mergedIssueTip: 'abc123',
        failedAt: new Date().toISOString(),
      },
    ])}\n`,
  );
  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  assert.equal(plan.pendingPostMergeCleanupTargets.length, 1);
  assert.equal(plan.pendingPostMergeCleanupTargets[0]?.issueName, '001');
});
