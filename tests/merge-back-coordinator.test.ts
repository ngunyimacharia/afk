import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FakeAgentExecutionProvider } from '../src/agent-execution-provider.js';
import { MergeBackCoordinator } from '../src/merge-back-coordinator.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { mkRepoLocalTempDir } from './helpers/temp-repo.js';

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
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
