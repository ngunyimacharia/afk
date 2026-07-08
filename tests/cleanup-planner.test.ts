import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CleanupPlanner } from '../src/cleanup.js';
import { resolveExecutable } from '../src/executable-resolution.js';
import type {
  SandcastleCleanupResource,
  SandcastlePhaseAttempt,
  SandcastleRuntimeRecord,
  SandcastleTrackerSource,
} from '../src/sandcastle-runtime-store.js';

function sandcastleRecordPath(repoRoot: string, runId: string): string {
  return path.join(repoRoot, '.scratch', 'sandcastle-runtime', 'runs', runId, 'record.json');
}

function writeSandcastleRecord(recordPath: string, record: SandcastleRuntimeRecord): void {
  mkdirSync(path.dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
}

function makeSandcastleRecord(input: {
  runId: string;
  feature: string;
  issue: string;
  ticketPath: string;
  status: 'running' | 'completed' | 'handoff' | 'failed' | 'blocked' | 'interrupted';
  worktreePath?: string;
  cleanupResources?: SandcastleCleanupResource[];
  phases?: SandcastlePhaseAttempt[];
  trackerSource?: SandcastleTrackerSource;
  createdAt?: string;
}): SandcastleRuntimeRecord {
  return {
    schemaVersion: 1,
    runId: input.runId,
    createdAt: input.createdAt ?? '2026-05-18T00:00:00.000Z',
    updatedAt: input.createdAt ?? '2026-05-18T00:00:00.000Z',
    ticket: {
      featureSlug: input.feature,
      issueName: input.issue,
      label: `${input.feature}/${input.issue}`,
      ticketPath: input.ticketPath,
    },
    trackerSource: input.trackerSource ?? 'scratch',
    provider: { provider: 'opencode', model: 'test' },
    sandbox: { mode: 'none' },
    branch: `afk/${input.feature}/${input.issue}`,
    worktreePath: input.worktreePath ?? path.join('/tmp', `worktree-${input.runId}`),
    phases: input.phases ?? [],
    commits: [],
    logs: { run: `/tmp/${input.runId}.log`, phases: [] },
    terminal: { status: input.status },
    providerFailures: [],
    cleanupResources: input.cleanupResources ?? [],
    cleanupResults: [],
  };
}

const GIT_PATH = resolveExecutable('git');

function git(repoRoot: string, args: string[]): string {
  return execFileSync(GIT_PATH, args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function initRepo(repoRoot: string): void {
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  writeFileSync(path.join(repoRoot, 'README.md'), 'test\n');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-m', 'init']);
}

test('empty repo returns empty plan', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  assert.deepEqual(plan.terminalTargets, []);
  assert.deepEqual(plan.sandcastleResourceTargets, []);
  assert.deepEqual(plan.orphanedWorktreeTargets, []);
  assert.deepEqual(plan.pendingPostMergeCleanupTargets, []);
  assert.deepEqual(plan.preservedIssues, []);
});

test('classifies only terminal Sandcastle runs for cleanup', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  const donePath = path.join(issuesDir, 'done.md');
  const humanPath = path.join(issuesDir, 'human.md');
  writeFileSync(donePath, '---\nstatus: done\n---\n');
  writeFileSync(humanPath, '---\nstatus: ready-for-human\n---\n');
  writeSandcastleRecord(
    sandcastleRecordPath(repoRoot, 'run-done'),
    makeSandcastleRecord({
      runId: 'run-done',
      feature: 'feat',
      issue: 'done',
      ticketPath: donePath,
      status: 'completed',
    }),
  );
  writeSandcastleRecord(
    sandcastleRecordPath(repoRoot, 'run-human'),
    makeSandcastleRecord({
      runId: 'run-human',
      feature: 'feat',
      issue: 'human',
      ticketPath: humanPath,
      status: 'running',
    }),
  );
  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  assert.equal(plan.terminalTargets.length, 1);
  assert.equal(plan.terminalTargets[0]?.issuePath, donePath);
  assert.equal(plan.preservedIssues.length, 1);
  assert.equal(plan.preservedIssues[0], humanPath);
});

test('plans completed scratch feature directories for deletion without Sandcastle records', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const featureDir = path.join(repoRoot, '.scratch', 'feat');
  const issuesDir = path.join(featureDir, 'issues');
  mkdirSync(issuesDir, { recursive: true });
  const firstPath = path.join(issuesDir, '001.md');
  const secondPath = path.join(issuesDir, '002.md');
  writeFileSync(path.join(featureDir, 'PRD.md'), '---\nstatus: ready-for-agent\n---\n# Feature\n');
  writeFileSync(firstPath, '---\nstatus: done\n---\n');
  writeFileSync(secondPath, '---\nstatus: resolved\n---\n');

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();

  assert.deepEqual(plan.issueDeletionTargets.map((target) => target.issuePath).sort(), [firstPath, secondPath].sort());
  assert.deepEqual(plan.featureDirectoriesToDelete, [featureDir]);
});

test('plans missing PRD issues instead of deleting partially represented feature', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const featureDir = path.join(repoRoot, '.scratch', 'feat');
  const issuesDir = path.join(featureDir, 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(
    path.join(featureDir, 'PRD.md'),
    [
      '# Feature',
      '',
      '## Goals',
      '',
      '1. Make stale-session detection tolerate long-running tools.',
      '2. Validate test-environment readiness before launching tickets.',
      '3. Improve observability so summaries explain slow runs.',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(issuesDir, '03-stale-detection-recovery.md'),
    '---\nstatus: done\n---\n\n## Make stale detection tolerate long-running tools\n',
  );

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();

  assert.deepEqual(plan.featureDirectoriesToDelete, []);
  assert.equal(plan.prdIssueCreationTargets.length, 2);
  assert.match(plan.prdIssueCreationTargets[0]?.issuePath ?? '', /04-validate-test-environment-readiness/);
  assert.match(plan.prdIssueCreationTargets[1]?.issuePath ?? '', /05-improve-observability/);
});

test('preserves terminal issue when an active issue depends on it', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const featureDir = path.join(repoRoot, '.scratch', 'feat');
  const issuesDir = path.join(featureDir, 'issues');
  mkdirSync(issuesDir, { recursive: true });
  const dependencyPath = path.join(issuesDir, '01-foundation.md');
  writeFileSync(path.join(featureDir, 'PRD.md'), '# Feature\n');
  writeFileSync(dependencyPath, '---\nstatus: done\n---\n');
  writeFileSync(
    path.join(issuesDir, '02-followup.md'),
    '---\nstatus: ready-for-agent\nDepends-On:\n  - 01-foundation\n---\n',
  );

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();

  assert.deepEqual(
    plan.issueDeletionTargets.map((target) => target.issuePath),
    [],
  );
  assert.deepEqual(plan.featureDirectoriesToDelete, []);
});

test('preserves scratch feature directory when any issue is non-terminal', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const featureDir = path.join(repoRoot, '.scratch', 'feat');
  const issuesDir = path.join(featureDir, 'issues');
  mkdirSync(issuesDir, { recursive: true });
  const donePath = path.join(issuesDir, 'done.md');
  writeFileSync(path.join(featureDir, 'PRD.md'), '# Feature\n');
  writeFileSync(donePath, '---\nstatus: done\n---\n');
  writeFileSync(path.join(issuesDir, 'next.md'), '---\nstatus: ready-for-agent\n---\n');

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();

  assert.deepEqual(
    plan.issueDeletionTargets.map((target) => target.issuePath),
    [donePath],
  );
  assert.deepEqual(plan.featureDirectoriesToDelete, []);
});

test('preserves completed scratch feature directory with non-canonical files', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const featureDir = path.join(repoRoot, '.scratch', 'feat');
  const issuesDir = path.join(featureDir, 'issues');
  mkdirSync(issuesDir, { recursive: true });
  const donePath = path.join(issuesDir, 'done.md');
  writeFileSync(path.join(featureDir, 'PRD.md'), '# Feature\n');
  writeFileSync(path.join(featureDir, 'notes.txt'), 'keep me\n');
  writeFileSync(donePath, '---\nstatus: done\n---\n');

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();

  assert.deepEqual(
    plan.issueDeletionTargets.map((target) => target.issuePath),
    [donePath],
  );
  assert.deepEqual(plan.featureDirectoriesToDelete, []);
});

test('plans Sandcastle cleanup resources for terminal runs', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  const runLogPath = path.join(repoRoot, '.scratch', 'sandcastle-runtime', 'runs', 'run-done', 'run.log');
  mkdirSync(issuesDir, { recursive: true });
  const donePath = path.join(issuesDir, 'done.md');
  writeFileSync(donePath, '---\nstatus: done\n---\n');
  writeSandcastleRecord(
    sandcastleRecordPath(repoRoot, 'run-done'),
    makeSandcastleRecord({
      runId: 'run-done',
      feature: 'feat',
      issue: 'done',
      ticketPath: donePath,
      status: 'completed',
      cleanupResources: [{ type: 'log', id: 'run-log', path: runLogPath }],
    }),
  );
  writeFileSync(runLogPath, 'log');
  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  assert.equal(plan.terminalTargets.length, 1);
  assert.equal(plan.sandcastleResourceTargets?.length, 1);
  assert.equal(plan.sandcastleResourceTargets?.[0]?.resource.type, 'log');
  assert.equal(plan.sandcastleResourceTargets?.[0]?.resource.path, runLogPath);
});

test('plans local Linear mirrors via Sandcastle ticket path', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const mirrorPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'linear-mirrors', 'eng-1-eng-2.md');
  mkdirSync(path.dirname(mirrorPath), { recursive: true });
  writeFileSync(mirrorPath, 'Linear mirror\n');
  writeSandcastleRecord(
    sandcastleRecordPath(repoRoot, 'run-linear'),
    makeSandcastleRecord({
      runId: 'run-linear',
      feature: 'eng-1',
      issue: 'eng-2',
      ticketPath: mirrorPath,
      status: 'completed',
      trackerSource: 'linear',
    }),
  );

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  assert.equal(plan.terminalTargets.length, 1);
  assert.equal(plan.terminalTargets[0]?.issuePath, mirrorPath);
});

test('preserves running Sandcastle runs', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  const runningPath = path.join(issuesDir, 'active.md');
  writeFileSync(runningPath, '---\nstatus: in-progress\n---\n');
  writeSandcastleRecord(
    sandcastleRecordPath(repoRoot, 'run-active'),
    makeSandcastleRecord({
      runId: 'run-active',
      feature: 'feat',
      issue: 'active',
      ticketPath: runningPath,
      status: 'running',
    }),
  );
  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  assert.equal(plan.terminalTargets.length, 0);
  assert.equal(plan.preservedIssues.length, 1);
  assert.equal(plan.preservedIssues[0], runningPath);
});

test('treats handoff Sandcastle runs as terminal cleanup targets', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  const handoffPath = path.join(issuesDir, 'handoff.md');
  writeFileSync(handoffPath, '---\nstatus: done\n---\n');
  writeSandcastleRecord(
    sandcastleRecordPath(repoRoot, 'run-handoff'),
    makeSandcastleRecord({
      runId: 'run-handoff',
      feature: 'feat',
      issue: 'handoff',
      ticketPath: handoffPath,
      status: 'handoff',
    }),
  );
  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  assert.equal(plan.terminalTargets.length, 1);
  assert.equal(plan.terminalTargets[0]?.issuePath, handoffPath);
});

test('treats failed, blocked, and interrupted as terminal', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  const statuses: Array<'failed' | 'blocked' | 'interrupted'> = ['failed', 'blocked', 'interrupted'];
  for (const status of statuses) {
    const ticketPath = path.join(issuesDir, `${status}.md`);
    writeFileSync(ticketPath, '---\nstatus: done\n---\n');
    writeSandcastleRecord(
      sandcastleRecordPath(repoRoot, `run-${status}`),
      makeSandcastleRecord({
        runId: `run-${status}`,
        feature: 'feat',
        issue: status,
        ticketPath,
        status,
      }),
    );
  }
  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  assert.equal(plan.terminalTargets.length, 3);
  const reasons = plan.terminalTargets.map((target) => target.reason);
  assert.ok(reasons.every((reason) => reason.startsWith('terminal Sandcastle run:')));
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

test('plans orphaned issue worktree by Sandcastle worktreePath', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  initRepo(repoRoot);
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  const donePath = path.join(issuesDir, 'done.md');
  writeFileSync(donePath, '---\nstatus: done\n---\n');

  git(repoRoot, ['branch', 'feat']);
  const issueWorktreePath = path.join(repoRoot, '.worktree', 'feat-001');
  git(repoRoot, ['worktree', 'add', '--detach', issueWorktreePath]);
  const branchName = 'afk/feat/001';
  git(repoRoot, ['branch', '--no-track', branchName]);
  git(issueWorktreePath, ['checkout', branchName]);

  writeSandcastleRecord(
    sandcastleRecordPath(repoRoot, 'run-done'),
    makeSandcastleRecord({
      runId: 'run-done',
      feature: 'feat',
      issue: 'done',
      ticketPath: donePath,
      status: 'completed',
      worktreePath: issueWorktreePath,
    }),
  );

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  assert.equal(plan.orphanedWorktreeTargets.length, 1);
  assert.equal(plan.orphanedWorktreeTargets[0]?.feature, 'feat');
  assert.equal(plan.orphanedWorktreeTargets[0]?.issueName, 'done');
  assert.equal(plan.orphanedWorktreeTargets[0]?.branchName, branchName);
  assert.equal(plan.orphanedWorktreeTargets[0]?.worktreePath, realpathSync(issueWorktreePath));
});

test('plans orphaned issue worktree by branch naming convention', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  initRepo(repoRoot);
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  const donePath = path.join(issuesDir, '001.md');
  writeFileSync(donePath, '---\nstatus: done\n---\n');

  git(repoRoot, ['branch', 'feat']);
  const branchName = 'afk/feat/001';
  git(repoRoot, ['branch', '--no-track', branchName, 'feat']);
  const issueWorktreePath = path.join(repoRoot, '.worktree', 'feat-001');
  git(repoRoot, ['worktree', 'add', issueWorktreePath, branchName]);

  writeSandcastleRecord(
    sandcastleRecordPath(repoRoot, 'run-001'),
    makeSandcastleRecord({
      runId: 'run-001',
      feature: 'feat',
      issue: '001',
      ticketPath: donePath,
      status: 'completed',
      worktreePath: issueWorktreePath,
    }),
  );

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  assert.equal(plan.orphanedWorktreeTargets.length, 1);
  assert.equal(plan.orphanedWorktreeTargets[0]?.feature, 'feat');
  assert.equal(plan.orphanedWorktreeTargets[0]?.issueName, '001');
  assert.equal(plan.orphanedWorktreeTargets[0]?.branchName, branchName);
  assert.equal(plan.orphanedWorktreeTargets[0]?.worktreePath, realpathSync(issueWorktreePath));
});

test('preserves non-terminal issue worktree by branch naming convention', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  initRepo(repoRoot);
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  const activePath = path.join(issuesDir, '001.md');
  writeFileSync(activePath, '---\nstatus: ready-for-agent\n---\n');

  git(repoRoot, ['branch', 'feat']);
  const branchName = 'afk/feat/001';
  git(repoRoot, ['branch', '--no-track', branchName, 'feat']);
  const issueWorktreePath = path.join(repoRoot, '.worktree', 'feat-001');
  git(repoRoot, ['worktree', 'add', issueWorktreePath, branchName]);

  writeSandcastleRecord(
    sandcastleRecordPath(repoRoot, 'run-001'),
    makeSandcastleRecord({
      runId: 'run-001',
      feature: 'feat',
      issue: '001',
      ticketPath: activePath,
      status: 'running',
      worktreePath: issueWorktreePath,
    }),
  );

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  assert.equal(plan.orphanedWorktreeTargets.length, 0);
  assert.equal(plan.preservedIssues.length, 1);
  assert.equal(plan.preservedIssues[0], activePath);
});

test('skips orphaned worktrees referenced by pending post-merge cleanup', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  initRepo(repoRoot);
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  const donePath = path.join(issuesDir, '001.md');
  writeFileSync(donePath, '---\nstatus: done\n---\n');

  git(repoRoot, ['branch', 'feat']);
  const branchName = 'afk/feat/001';
  git(repoRoot, ['branch', '--no-track', branchName, 'feat']);
  const issueWorktreePath = path.join(repoRoot, '.worktree', 'feat-001');
  git(repoRoot, ['worktree', 'add', issueWorktreePath, branchName]);

  writeSandcastleRecord(
    sandcastleRecordPath(repoRoot, 'run-001'),
    makeSandcastleRecord({
      runId: 'run-001',
      feature: 'feat',
      issue: '001',
      ticketPath: donePath,
      status: 'completed',
      worktreePath: issueWorktreePath,
    }),
  );

  const logsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs');
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    path.join(logsDir, 'pending-post-merge-cleanup.json'),
    `${JSON.stringify([
      {
        feature: 'feat',
        issueName: '001',
        branchName,
        worktreePath: issueWorktreePath,
        featureWorktreePath: path.join(repoRoot, '.worktree', 'feat'),
        featureBranchName: 'feat',
        mergedIssueTip: git(repoRoot, ['rev-parse', 'HEAD']),
        failedAt: new Date().toISOString(),
      },
    ])}\n`,
  );

  const plan = new CleanupPlanner({ repoRoot }).buildPlan();
  assert.equal(plan.orphanedWorktreeTargets.length, 0);
});
