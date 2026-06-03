import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FakeAgentExecutionProvider } from '../src/agent-execution-provider.js';
import { resolveExecutable } from '../src/executable-resolution.js';
import { mergeCompletedFeaturesToBase } from '../src/feature-base-merge.js';
import { MergeBackCoordinator } from '../src/merge-back-coordinator.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { mkRepoLocalTempDir } from './helpers/temp-repo.js';

const GIT_PATH = resolveExecutable('git');

function git(repoRoot: string, args: string[]): string {
  return execFileSync(GIT_PATH, args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function createRepo(prefix: string): string {
  const repoRoot = mkRepoLocalTempDir(prefix);
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  writeFileSync(path.join(repoRoot, 'README.md'), 'test\n');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-m', 'initial']);
  return repoRoot;
}

function createFeatureWorktree(repoRoot: string, feature: string): string {
  git(repoRoot, ['branch', feature]);
  const worktreePath = path.join(repoRoot, '.worktree', feature);
  git(repoRoot, ['worktree', 'add', worktreePath, feature]);
  return worktreePath;
}

function createScratchWorktree(
  repoRoot: string,
  feature: string,
  issueName: string,
  baseRef: string,
): { branchName: string; worktreePath: string } {
  const branchName = `afk/${feature}/${issueName}`;
  git(repoRoot, ['branch', '--no-track', branchName, baseRef]);
  const worktreePath = path.join(repoRoot, '.worktree', `${feature}-${issueName}`);
  git(repoRoot, ['worktree', 'add', worktreePath, branchName]);
  return { branchName, worktreePath };
}

function setupTicketMetadata(
  store: RuntimeStore,
  feature: string,
  issueName: string,
): { metadataPath: string; logPath: string } {
  const record = store.createRecord({ featureSlug: feature, issueName, ticketPath: `/tmp/${feature}/${issueName}.md` });
  return { metadataPath: record.metadataPath, logPath: record.logPath };
}

test('returns success for empty ticket list', async () => {
  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: new FakeAgentExecutionProvider({ status: 'completed', sessionId: null, removable: true }),
    runtimeStore: new RuntimeStore({ repoRoot: mkRepoLocalTempDir('empty') }),
  });

  const result = await coordinator.mergeWave({
    repoRoot: '/tmp',
    feature: 'feat-a',
    featureWorktreePath: '/tmp',
    featureBranchName: 'feat-a',
    wave: 0,
    tickets: [],
    model: { id: 'model-1' },
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.mergedTickets, []);
  assert.deepEqual(result.failedTickets, []);
  assert.deepEqual(result.cleanupResults, []);
});

test('merges tickets in dependency order and advances feature branch', async () => {
  const repoRoot = createRepo('merge-back-order-');
  const feature = 'feat-a';
  const featureWorktreePath = createFeatureWorktree(repoRoot, feature);

  const scratch1 = createScratchWorktree(repoRoot, feature, '001', feature);
  writeFileSync(path.join(scratch1.worktreePath, 'a.txt'), 'a\n');
  git(scratch1.worktreePath, ['add', 'a.txt']);
  git(scratch1.worktreePath, ['commit', '-m', 'ticket-001']);

  const scratch2 = createScratchWorktree(repoRoot, feature, '002', feature);
  writeFileSync(path.join(scratch2.worktreePath, 'b.txt'), 'b\n');
  git(scratch2.worktreePath, ['add', 'b.txt']);
  git(scratch2.worktreePath, ['commit', '-m', 'ticket-002']);

  const store = new RuntimeStore({ repoRoot });
  const meta1 = setupTicketMetadata(store, feature, '001');
  const meta2 = setupTicketMetadata(store, feature, '002');

  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: new FakeAgentExecutionProvider({ status: 'completed', sessionId: null, removable: true }),
    runtimeStore: store,
  });

  const result = await coordinator.mergeWave({
    repoRoot,
    feature,
    featureWorktreePath,
    featureBranchName: feature,
    wave: 0,
    tickets: [
      {
        feature,
        issueName: '001',
        branchName: scratch1.branchName,
        worktreePath: scratch1.worktreePath,
        dependsOn: [],
        ...meta1,
      },
      {
        feature,
        issueName: '002',
        branchName: scratch2.branchName,
        worktreePath: scratch2.worktreePath,
        dependsOn: ['001'],
        ...meta2,
      },
    ],
    model: { id: 'model-1' },
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.mergedTickets, ['001', '002']);
  assert.equal(result.failedTickets.length, 0);
  assert.equal(result.cleanupResults.length, 2);
  assert.equal(
    result.cleanupResults.every((entry) => entry.success),
    true,
  );

  assert.equal(readFileSync(path.join(featureWorktreePath, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(readFileSync(path.join(featureWorktreePath, 'b.txt'), 'utf8'), 'b\n');

  const log = git(featureWorktreePath, ['log', '--oneline', '--all']);
  assert.equal(log.includes('ticket-001'), true);
  assert.equal(log.includes('ticket-002'), true);

  const metadata1 = store.readMetadata(meta1.metadataPath);
  assert.equal(metadata1.MERGE_STATUS, 'merged');
  const metadata2 = store.readMetadata(meta2.metadataPath);
  assert.equal(metadata2.MERGE_STATUS, 'merged');
});

test('merges completed feature branch to base and deletes feature resources', async () => {
  const repoRoot = createRepo('feature-base-merge-');
  const feature = 'feat-a';
  const featureWorktreePath = createFeatureWorktree(repoRoot, feature);
  writeFileSync(path.join(featureWorktreePath, 'feature.txt'), 'feature\n');
  git(featureWorktreePath, ['add', 'feature.txt']);
  git(featureWorktreePath, ['commit', '-m', 'feature work']);

  const store = new RuntimeStore({ repoRoot });
  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: new FakeAgentExecutionProvider({ status: 'completed', sessionId: null, removable: true }),
    runtimeStore: store,
  });

  const results = await mergeCompletedFeaturesToBase({
    repoRoot,
    baseBranch: 'main',
    features: [feature],
    checkoutsByFeature: {
      [feature]: {
        featureSlug: feature,
        defaultWorktreeName: feature,
        effectiveWorktreeName: feature,
        defaultBranchName: feature,
        effectiveBranchName: feature,
        worktreePath: featureWorktreePath,
      },
    },
    coordinator,
    model: { id: 'model-1' },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.feature, feature);
  assert.equal(results[0]?.branchName, feature);
  assert.equal(results[0]?.success, true);
  assert.equal(results[0]?.deletedBranch, true);
  assert.equal(results[0]?.deletedWorktree, true);
  assert.equal(git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  assert.equal(readFileSync(path.join(repoRoot, 'feature.txt'), 'utf8'), 'feature\n');
  assert.equal(existsSync(featureWorktreePath), false);
  assert.throws(() => git(repoRoot, ['rev-parse', '--verify', feature]));
});

test('locks feature during merge and releases after', async () => {
  const repoRoot = createRepo('merge-back-lock-');
  const feature = 'feat-a';
  const featureWorktreePath = createFeatureWorktree(repoRoot, feature);

  const scratch = createScratchWorktree(repoRoot, feature, '001', feature);
  writeFileSync(path.join(scratch.worktreePath, 'a.txt'), 'a\n');
  git(scratch.worktreePath, ['add', 'a.txt']);
  git(scratch.worktreePath, ['commit', '-m', 'ticket-001']);

  const store = new RuntimeStore({ repoRoot });
  const meta = setupTicketMetadata(store, feature, '001');

  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: new FakeAgentExecutionProvider({ status: 'completed', sessionId: null, removable: true }),
    runtimeStore: store,
  });

  assert.equal(coordinator.isLocked(feature), false);

  const promise = coordinator.mergeWave({
    repoRoot,
    feature,
    featureWorktreePath,
    featureBranchName: feature,
    wave: 0,
    tickets: [
      { feature, issueName: '001', branchName: scratch.branchName, worktreePath: scratch.worktreePath, ...meta },
    ],
    model: { id: 'model-1' },
  });

  assert.equal(coordinator.isLocked(feature), true);
  await promise;
  assert.equal(coordinator.isLocked(feature), false);
});

test('detects conflicts, invokes reviewer agent, and resolves', async () => {
  const repoRoot = createRepo('merge-back-conflict-');
  const feature = 'feat-a';
  const featureWorktreePath = createFeatureWorktree(repoRoot, feature);

  writeFileSync(path.join(featureWorktreePath, 'shared.txt'), 'base\n');
  git(featureWorktreePath, ['add', 'shared.txt']);
  git(featureWorktreePath, ['commit', '-m', 'add-shared']);

  const scratch1 = createScratchWorktree(repoRoot, feature, '001', feature);
  writeFileSync(path.join(scratch1.worktreePath, 'shared.txt'), 'base\nbranch1\n');
  git(scratch1.worktreePath, ['add', 'shared.txt']);
  git(scratch1.worktreePath, ['commit', '-m', 'ticket-001']);

  const scratch2 = createScratchWorktree(repoRoot, feature, '002', feature);
  writeFileSync(path.join(scratch2.worktreePath, 'shared.txt'), 'base\nbranch2\n');
  git(scratch2.worktreePath, ['add', 'shared.txt']);
  git(scratch2.worktreePath, ['commit', '-m', 'ticket-002']);

  const store = new RuntimeStore({ repoRoot });
  const meta1 = setupTicketMetadata(store, feature, '001');
  const meta2 = setupTicketMetadata(store, feature, '002');

  const agentProvider = new FakeAgentExecutionProvider(async () => {
    writeFileSync(path.join(featureWorktreePath, 'shared.txt'), 'base\nbranch1\nbranch2\n');
    git(featureWorktreePath, ['add', 'shared.txt']);
    return { status: 'completed', sessionId: null, removable: true, output: ['resolved'] };
  });

  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: agentProvider,
    runtimeStore: store,
    conflictResolutionBudget: 2,
  });

  const result = await coordinator.mergeWave({
    repoRoot,
    feature,
    featureWorktreePath,
    featureBranchName: feature,
    wave: 0,
    tickets: [
      { feature, issueName: '001', branchName: scratch1.branchName, worktreePath: scratch1.worktreePath, ...meta1 },
      { feature, issueName: '002', branchName: scratch2.branchName, worktreePath: scratch2.worktreePath, ...meta2 },
    ],
    model: { id: 'model-1' },
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.mergedTickets, ['001', '002']);
  assert.equal(readFileSync(path.join(featureWorktreePath, 'shared.txt'), 'utf8'), 'base\nbranch1\nbranch2\n');
  assert.equal(result.cleanupResults.length, 2);
  assert.equal(
    result.cleanupResults.every((entry) => entry.success),
    true,
  );

  const metadata2 = store.readMetadata(meta2.metadataPath);
  assert.equal(metadata2.MERGE_STATUS, 'conflict-resolved');
});

test('marks ticket failed when conflict resolution exceeds budget', async () => {
  const repoRoot = createRepo('merge-back-budget-');
  const feature = 'feat-a';
  const featureWorktreePath = createFeatureWorktree(repoRoot, feature);

  writeFileSync(path.join(featureWorktreePath, 'shared.txt'), 'base\n');
  git(featureWorktreePath, ['add', 'shared.txt']);
  git(featureWorktreePath, ['commit', '-m', 'add-shared']);

  const scratch1 = createScratchWorktree(repoRoot, feature, '001', feature);
  writeFileSync(path.join(scratch1.worktreePath, 'shared.txt'), 'base\nbranch1\n');
  git(scratch1.worktreePath, ['add', 'shared.txt']);
  git(scratch1.worktreePath, ['commit', '-m', 'ticket-001']);

  const scratch2 = createScratchWorktree(repoRoot, feature, '002', feature);
  writeFileSync(path.join(scratch2.worktreePath, 'shared.txt'), 'base\nbranch2\n');
  git(scratch2.worktreePath, ['add', 'shared.txt']);
  git(scratch2.worktreePath, ['commit', '-m', 'ticket-002']);

  const store = new RuntimeStore({ repoRoot });
  const meta1 = setupTicketMetadata(store, feature, '001');
  const meta2 = setupTicketMetadata(store, feature, '002');

  const agentProvider = new FakeAgentExecutionProvider({
    status: 'completed',
    sessionId: null,
    removable: true,
    output: ['did not resolve'],
  });

  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: agentProvider,
    runtimeStore: store,
    conflictResolutionBudget: 1,
  });

  const result = await coordinator.mergeWave({
    repoRoot,
    feature,
    featureWorktreePath,
    featureBranchName: feature,
    wave: 0,
    tickets: [
      { feature, issueName: '001', branchName: scratch1.branchName, worktreePath: scratch1.worktreePath, ...meta1 },
      { feature, issueName: '002', branchName: scratch2.branchName, worktreePath: scratch2.worktreePath, ...meta2 },
    ],
    model: { id: 'model-1' },
  });

  assert.equal(result.success, false);
  assert.deepEqual(result.mergedTickets, ['001']);
  assert.equal(result.failedTickets.length, 1);
  assert.equal(result.failedTickets[0].issueName, '002');
  assert.ok(result.failedTickets[0].reason.includes('attempts'));
  assert.ok(result.failedTickets[0].conflictPaths);
  assert.equal(result.failedTickets[0].conflictPaths?.length > 0, true);

  const metadata2 = store.readMetadata(meta2.metadataPath);
  assert.equal(metadata2.MERGE_STATUS, 'failed');
  assert.ok(metadata2.MERGE_CONFLICT_PATHS);
  assert.equal(metadata2.MERGE_CONFLICT_PATHS?.length > 0, true);
});

test('fails merge when readiness checks fail after conflict resolution', async () => {
  const repoRoot = createRepo('merge-back-readiness-');
  const feature = 'feat-a';
  const featureWorktreePath = createFeatureWorktree(repoRoot, feature);

  writeFileSync(
    path.join(featureWorktreePath, 'package.json'),
    JSON.stringify({ scripts: { lint: 'echo "lint error" && exit 1' } }),
  );
  git(featureWorktreePath, ['add', 'package.json']);
  git(featureWorktreePath, ['commit', '-m', 'add-package']);

  writeFileSync(path.join(featureWorktreePath, 'shared.txt'), 'base\n');
  git(featureWorktreePath, ['add', 'shared.txt']);
  git(featureWorktreePath, ['commit', '-m', 'add-shared']);

  const scratch1 = createScratchWorktree(repoRoot, feature, '001', feature);
  writeFileSync(path.join(scratch1.worktreePath, 'shared.txt'), 'base\nbranch1\n');
  git(scratch1.worktreePath, ['add', 'shared.txt']);
  git(scratch1.worktreePath, ['commit', '-m', 'ticket-001']);

  const scratch2 = createScratchWorktree(repoRoot, feature, '002', feature);
  writeFileSync(path.join(scratch2.worktreePath, 'shared.txt'), 'base\nbranch2\n');
  git(scratch2.worktreePath, ['add', 'shared.txt']);
  git(scratch2.worktreePath, ['commit', '-m', 'ticket-002']);

  const store = new RuntimeStore({ repoRoot });
  const meta1 = setupTicketMetadata(store, feature, '001');
  const meta2 = setupTicketMetadata(store, feature, '002');

  const agentProvider = new FakeAgentExecutionProvider(async () => {
    writeFileSync(path.join(featureWorktreePath, 'shared.txt'), 'base\nbranch1\nbranch2\n');
    git(featureWorktreePath, ['add', 'shared.txt']);
    return { status: 'completed', sessionId: null, removable: true, output: ['resolved'] };
  });

  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: agentProvider,
    runtimeStore: store,
    conflictResolutionBudget: 2,
  });

  const result = await coordinator.mergeWave({
    repoRoot,
    feature,
    featureWorktreePath,
    featureBranchName: feature,
    wave: 0,
    tickets: [
      { feature, issueName: '001', branchName: scratch1.branchName, worktreePath: scratch1.worktreePath, ...meta1 },
      { feature, issueName: '002', branchName: scratch2.branchName, worktreePath: scratch2.worktreePath, ...meta2 },
    ],
    model: { id: 'model-1' },
  });

  assert.equal(result.success, false);
  assert.equal(result.failedTickets[0].issueName, '002');
  assert.ok(result.failedTickets[0].reason.includes('Readiness checks failed'));
});

test('tracks merged waves via isWaveMerged', async () => {
  const repoRoot = createRepo('merge-back-wave-');
  const feature = 'feat-a';
  const featureWorktreePath = createFeatureWorktree(repoRoot, feature);

  const scratch = createScratchWorktree(repoRoot, feature, '001', feature);
  writeFileSync(path.join(scratch.worktreePath, 'a.txt'), 'a\n');
  git(scratch.worktreePath, ['add', 'a.txt']);
  git(scratch.worktreePath, ['commit', '-m', 'ticket-001']);

  const store = new RuntimeStore({ repoRoot });
  const meta = setupTicketMetadata(store, feature, '001');

  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: new FakeAgentExecutionProvider({ status: 'completed', sessionId: null, removable: true }),
    runtimeStore: store,
  });

  assert.equal(coordinator.isWaveMerged(feature, 0, ['001']), false);

  await coordinator.mergeWave({
    repoRoot,
    feature,
    featureWorktreePath,
    featureBranchName: feature,
    wave: 0,
    tickets: [
      { feature, issueName: '001', branchName: scratch.branchName, worktreePath: scratch.worktreePath, ...meta },
    ],
    model: { id: 'model-1' },
  });

  assert.equal(coordinator.isWaveMerged(feature, 0, ['001']), true);
});

test('discards feature worktree changes before merge wave', async () => {
  const repoRoot = createRepo('merge-back-dirty-');
  const feature = 'feat-a';
  const featureWorktreePath = createFeatureWorktree(repoRoot, feature);

  const scratch = createScratchWorktree(repoRoot, feature, '001', feature);
  writeFileSync(path.join(scratch.worktreePath, 'a.txt'), 'a\n');
  git(scratch.worktreePath, ['add', 'a.txt']);
  git(scratch.worktreePath, ['commit', '-m', 'ticket-001']);

  writeFileSync(path.join(featureWorktreePath, 'README.md'), 'dirty\n');
  writeFileSync(path.join(featureWorktreePath, 'temp.txt'), 'temp\n');

  const store = new RuntimeStore({ repoRoot });
  const meta = setupTicketMetadata(store, feature, '001');

  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: new FakeAgentExecutionProvider({ status: 'completed', sessionId: null, removable: true }),
    runtimeStore: store,
  });

  const result = await coordinator.mergeWave({
    repoRoot,
    feature,
    featureWorktreePath,
    featureBranchName: feature,
    wave: 0,
    tickets: [
      { feature, issueName: '001', branchName: scratch.branchName, worktreePath: scratch.worktreePath, ...meta },
    ],
    model: { id: 'model-1' },
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.mergedTickets, ['001']);
  assert.equal(result.failedTickets.length, 0);
  assert.equal(readFileSync(path.join(featureWorktreePath, 'README.md'), 'utf8'), 'test\n');
  assert.equal(git(featureWorktreePath, ['status', '--porcelain']), '');
  assert.equal(result.cleanupResults.length, 1);
  assert.equal(result.cleanupResults[0].success, true);
});

test('reports post-merge cleanup failure without failing merge pipeline', async () => {
  const repoRoot = createRepo('merge-back-cleanup-failure-');
  const feature = 'feat-a';
  const featureWorktreePath = createFeatureWorktree(repoRoot, feature);

  const scratch = createScratchWorktree(repoRoot, feature, '001', feature);
  writeFileSync(path.join(scratch.worktreePath, 'a.txt'), 'a\n');
  git(scratch.worktreePath, ['add', 'a.txt']);
  git(scratch.worktreePath, ['commit', '-m', 'ticket-001']);

  const store = new RuntimeStore({ repoRoot });
  const meta = setupTicketMetadata(store, feature, '001');

  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: new FakeAgentExecutionProvider({ status: 'completed', sessionId: null, removable: true }),
    runtimeStore: store,
  });

  const result = await coordinator.mergeWave({
    repoRoot,
    feature,
    featureWorktreePath,
    featureBranchName: feature,
    wave: 0,
    tickets: [
      {
        feature,
        issueName: '001',
        branchName: scratch.branchName,
        worktreePath: path.join(repoRoot, '.worktree', 'does-not-exist'),
        ...meta,
      },
    ],
    model: { id: 'model-1' },
  });

  assert.equal(result.success, true);
  assert.equal(result.failedTickets.length, 0);
  assert.equal(result.cleanupResults.length, 1);
  assert.equal(result.cleanupResults[0].success, false);
  assert.equal(result.cleanupResults[0].deletedBranch, false);
  assert.equal(result.cleanupResults[0].deletedWorktree, false);
  assert.equal(typeof result.cleanupResults[0].warning, 'string');
  assert.equal(result.cleanupResults[0].warning?.includes('unavailable'), true);
  const pendingPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'pending-post-merge-cleanup.json');
  const pending = JSON.parse(readFileSync(pendingPath, 'utf8')) as Array<{ issueName: string }>;
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.issueName, '001');
});

test('skips deletion when merge proof guard fails', async () => {
  const repoRoot = createRepo('merge-back-guard-merge-proof-');
  const feature = 'feat-a';
  const featureWorktreePath = createFeatureWorktree(repoRoot, feature);

  const scratch = createScratchWorktree(repoRoot, feature, '001', feature);
  writeFileSync(path.join(scratch.worktreePath, 'a.txt'), 'a\n');
  git(scratch.worktreePath, ['add', 'a.txt']);
  git(scratch.worktreePath, ['commit', '-m', 'ticket-001']);

  const store = new RuntimeStore({ repoRoot });
  const meta = setupTicketMetadata(store, feature, '001');

  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: new FakeAgentExecutionProvider({ status: 'completed', sessionId: null, removable: true }),
    runtimeStore: store,
  });

  const result = await coordinator.mergeWave({
    repoRoot,
    feature,
    featureWorktreePath,
    featureBranchName: 'main',
    wave: 0,
    tickets: [
      { feature, issueName: '001', branchName: scratch.branchName, worktreePath: scratch.worktreePath, ...meta },
    ],
    model: { id: 'model-1' },
  });

  assert.equal(result.success, true);
  assert.equal(result.cleanupResults.length, 1);
  assert.equal(result.cleanupResults[0].deletedBranch, false);
  assert.equal(result.cleanupResults[0].deletedWorktree, false);
  assert.equal(result.cleanupResults[0].warning?.includes('merge proof failed'), true);
});

test('skips deletion when issue worktree has uncommitted changes', async () => {
  const repoRoot = createRepo('merge-back-guard-dirty-worktree-');
  const feature = 'feat-a';
  const featureWorktreePath = createFeatureWorktree(repoRoot, feature);

  const scratch = createScratchWorktree(repoRoot, feature, '001', feature);
  writeFileSync(path.join(scratch.worktreePath, 'a.txt'), 'a\n');
  git(scratch.worktreePath, ['add', 'a.txt']);
  git(scratch.worktreePath, ['commit', '-m', 'ticket-001']);
  writeFileSync(path.join(scratch.worktreePath, 'dirty.txt'), 'dirty\n');

  const store = new RuntimeStore({ repoRoot });
  const meta = setupTicketMetadata(store, feature, '001');

  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: new FakeAgentExecutionProvider({ status: 'completed', sessionId: null, removable: true }),
    runtimeStore: store,
  });

  const result = await coordinator.mergeWave({
    repoRoot,
    feature,
    featureWorktreePath,
    featureBranchName: feature,
    wave: 0,
    tickets: [
      { feature, issueName: '001', branchName: scratch.branchName, worktreePath: scratch.worktreePath, ...meta },
    ],
    model: { id: 'model-1' },
  });

  assert.equal(result.success, true);
  assert.equal(result.cleanupResults.length, 1);
  assert.equal(result.cleanupResults[0].deletedBranch, false);
  assert.equal(result.cleanupResults[0].deletedWorktree, false);
  assert.equal(result.cleanupResults[0].warning?.includes('uncommitted changes'), true);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('two concurrent mergeWave calls into same feature branch serialize', async () => {
  const repoRoot = createRepo('merge-wave-concurrent-');
  const feature = 'feat-a';
  const featureWorktreePath = createFeatureWorktree(repoRoot, feature);

  writeFileSync(path.join(featureWorktreePath, 'shared.txt'), 'base\n');
  git(featureWorktreePath, ['add', 'shared.txt']);
  git(featureWorktreePath, ['commit', '-m', 'add-shared']);

  const scratch1 = createScratchWorktree(repoRoot, feature, '001', feature);
  writeFileSync(path.join(scratch1.worktreePath, 'shared.txt'), 'base\nbranch1\n');
  git(scratch1.worktreePath, ['add', 'shared.txt']);
  git(scratch1.worktreePath, ['commit', '-m', 'ticket-001']);

  const scratch2 = createScratchWorktree(repoRoot, feature, '002', feature);
  writeFileSync(path.join(scratch2.worktreePath, 'shared.txt'), 'base\nbranch2\n');
  git(scratch2.worktreePath, ['add', 'shared.txt']);
  git(scratch2.worktreePath, ['commit', '-m', 'ticket-002']);

  // Modify feature branch after creating scratch branches so every merge conflicts
  writeFileSync(path.join(featureWorktreePath, 'shared.txt'), 'base\nfeature\n');
  git(featureWorktreePath, ['add', 'shared.txt']);
  git(featureWorktreePath, ['commit', '-m', 'feature-update']);

  const store = new RuntimeStore({ repoRoot });
  const meta1 = setupTicketMetadata(store, feature, '001');
  const meta2 = setupTicketMetadata(store, feature, '002');

  const order: string[] = [];
  let callCount = 0;

  const agentProvider = new FakeAgentExecutionProvider(async () => {
    callCount++;
    const id = callCount === 1 ? 'first' : 'second';
    order.push(`${id}-start`);
    await sleep(100);
    order.push(`${id}-end`);
    writeFileSync(path.join(featureWorktreePath, 'shared.txt'), 'base\nfeature\nbranch1\nbranch2\n');
    git(featureWorktreePath, ['add', 'shared.txt']);
    return { status: 'completed', sessionId: null, removable: true, output: ['resolved'] };
  });

  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: agentProvider,
    runtimeStore: store,
    conflictResolutionBudget: 2,
  });

  const p1 = coordinator.mergeWave({
    repoRoot,
    feature,
    featureWorktreePath,
    featureBranchName: feature,
    wave: 0,
    tickets: [
      { feature, issueName: '001', branchName: scratch1.branchName, worktreePath: scratch1.worktreePath, ...meta1 },
    ],
    model: { id: 'model-1' },
  });

  const p2 = coordinator.mergeWave({
    repoRoot,
    feature,
    featureWorktreePath,
    featureBranchName: feature,
    wave: 1,
    tickets: [
      { feature, issueName: '002', branchName: scratch2.branchName, worktreePath: scratch2.worktreePath, ...meta2 },
    ],
    model: { id: 'model-1' },
  });

  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(r1.success, true);
  assert.equal(r2.success, true);

  // With serialization, agent calls must not interleave.
  assert.equal(order.length, 4);
  assert.equal(order[0], 'first-start');
  assert.equal(order[1], 'first-end');
  assert.equal(order[2], 'second-start');
  assert.equal(order[3], 'second-end');
});

test('two concurrent mergeFeatureBranchToBase calls into same base branch serialize', async () => {
  const repoRoot = createRepo('feature-base-concurrent-');
  const feature = 'feat-a';
  const featureWorktreePath = createFeatureWorktree(repoRoot, feature);

  writeFileSync(path.join(featureWorktreePath, 'shared.txt'), 'base\nfeature\n');
  git(featureWorktreePath, ['add', 'shared.txt']);
  git(featureWorktreePath, ['commit', '-m', 'feature work']);

  // main diverges from feature so merge will conflict
  writeFileSync(path.join(repoRoot, 'shared.txt'), 'base\nmain\n');
  git(repoRoot, ['add', 'shared.txt']);
  git(repoRoot, ['commit', '-m', 'main work']);

  const agentCalls: string[] = [];

  const agentProvider = new FakeAgentExecutionProvider(async () => {
    agentCalls.push('agent');
    await sleep(100);
    writeFileSync(path.join(repoRoot, 'shared.txt'), 'base\nfeature\nmain\n');
    git(repoRoot, ['add', 'shared.txt']);
    return { status: 'completed', sessionId: null, removable: true, output: ['resolved'] };
  });

  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: agentProvider,
    runtimeStore: new RuntimeStore({ repoRoot }),
    conflictResolutionBudget: 2,
  });

  const p1 = coordinator.mergeFeatureBranchToBase({
    repoRoot,
    baseBranch: 'main',
    featureBranch: feature,
    feature,
    model: { id: 'model-1' },
  });

  const p2 = coordinator.mergeFeatureBranchToBase({
    repoRoot,
    baseBranch: 'main',
    featureBranch: feature,
    feature,
    model: { id: 'model-1' },
  });

  const [r1, r2] = await Promise.all([p1, p2]);

  // One should succeed, the other should see already-merged state
  assert.ok(r1.success || r2.success);

  // With serialization, the agent is invoked at most once because the second
  // caller blocks until the first finishes the merge, then finds the branch
  // already merged into base.
  assert.equal(agentCalls.length <= 1, true);
});

test('mergeWave and mergeFeatureBranchToBase targeting same branch name serialize', async () => {
  const repoRoot = createRepo('cross-lock-concurrent-');
  const feature = 'feat-a';
  const featureWorktreePath = createFeatureWorktree(repoRoot, feature);

  // Set up feature worktree
  writeFileSync(path.join(featureWorktreePath, 'shared.txt'), 'base\n');
  git(featureWorktreePath, ['add', 'shared.txt']);
  git(featureWorktreePath, ['commit', '-m', 'add-shared']);

  const scratch = createScratchWorktree(repoRoot, feature, '001', feature);
  writeFileSync(path.join(scratch.worktreePath, 'shared.txt'), 'base\nticket\n');
  git(scratch.worktreePath, ['add', 'shared.txt']);
  git(scratch.worktreePath, ['commit', '-m', 'ticket-001']);

  // Diverge feature worktree after creating scratch so mergeWave will conflict
  writeFileSync(path.join(featureWorktreePath, 'shared.txt'), 'base\nfeature\n');
  git(featureWorktreePath, ['add', 'shared.txt']);
  git(featureWorktreePath, ['commit', '-m', 'feature-update']);

  // Diverge main after creating feature branch so base merge will conflict
  writeFileSync(path.join(repoRoot, 'shared.txt'), 'base\nmain\n');
  git(repoRoot, ['add', 'shared.txt']);
  git(repoRoot, ['commit', '-m', 'main work']);

  const baseFeature = 'feat-base';
  const baseFeatureWorktreePath = createFeatureWorktree(repoRoot, baseFeature);
  writeFileSync(path.join(baseFeatureWorktreePath, 'shared.txt'), 'base\nbase-feature\n');
  git(baseFeatureWorktreePath, ['add', 'shared.txt']);
  git(baseFeatureWorktreePath, ['commit', '-m', 'base feature work']);

  // Diverge main after creating feat-base so the merge will conflict
  writeFileSync(path.join(repoRoot, 'shared.txt'), 'base\nmain-update\n');
  git(repoRoot, ['add', 'shared.txt']);
  git(repoRoot, ['commit', '-m', 'main-update']);

  const store = new RuntimeStore({ repoRoot });
  const meta = setupTicketMetadata(store, feature, '001');

  const order: string[] = [];
  let callCount = 0;

  const agentProvider = new FakeAgentExecutionProvider(async () => {
    callCount++;
    const id = callCount === 1 ? 'first' : 'second';
    order.push(`${id}-start`);
    await sleep(100);
    order.push(`${id}-end`);
    const featureStatus = git(featureWorktreePath, ['status', '--porcelain']);
    if (featureStatus.includes('shared.txt')) {
      writeFileSync(path.join(featureWorktreePath, 'shared.txt'), 'base\nfeature\nticket\n');
      git(featureWorktreePath, ['add', 'shared.txt']);
    } else {
      writeFileSync(path.join(repoRoot, 'shared.txt'), 'base\nmain\nbase-feature\n');
      git(repoRoot, ['add', 'shared.txt']);
    }
    return { status: 'completed', sessionId: null, removable: true, output: ['resolved'] };
  });

  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: agentProvider,
    runtimeStore: store,
    conflictResolutionBudget: 2,
  });

  const p1 = coordinator.mergeWave({
    repoRoot,
    feature,
    featureWorktreePath,
    featureBranchName: 'main',
    wave: 0,
    tickets: [
      { feature, issueName: '001', branchName: scratch.branchName, worktreePath: scratch.worktreePath, ...meta },
    ],
    model: { id: 'model-1' },
  });

  const p2 = coordinator.mergeFeatureBranchToBase({
    repoRoot,
    baseBranch: 'main',
    featureBranch: baseFeature,
    feature: baseFeature,
    model: { id: 'model-1' },
  });

  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(r1.success, true);
  assert.equal(r2.success, true);

  // With serialization, agent calls must not interleave.
  assert.equal(order.length, 4);
  assert.equal(order[0], 'first-start');
  assert.equal(order[1], 'first-end');
  assert.equal(order[2], 'second-start');
  assert.equal(order[3], 'second-end');
});
