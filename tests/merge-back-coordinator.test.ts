import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FakeAgentExecutionProvider } from '../src/agent-execution-provider.js';
import { resolveExecutable } from '../src/executable-resolution.js';
import { BaseMergeLock, mergeCompletedFeaturesToBase } from '../src/feature-base-merge.js';
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

  const prompts: string[] = [];
  const agentProvider = new FakeAgentExecutionProvider(async (request) => {
    prompts.push(request.prompt);
    writeFileSync(path.join(featureWorktreePath, 'shared.txt'), 'base\nbranch1\nbranch2\n');
    git(featureWorktreePath, ['add', 'shared.txt']);
    return { status: 'completed', sessionId: null, removable: true, output: ['resolved'] };
  });

  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: agentProvider,
    runtimeStore: store,
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
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Attempt: 1 of 50/);
});

test('base merge conflict resolution uses default budget in prompt', async () => {
  const repoRoot = createRepo('feature-base-default-budget-');
  const feature = 'feat-a';
  const featureWorktreePath = createFeatureWorktree(repoRoot, feature);

  writeFileSync(path.join(featureWorktreePath, 'shared.txt'), 'base\nfeature\n');
  git(featureWorktreePath, ['add', 'shared.txt']);
  git(featureWorktreePath, ['commit', '-m', 'feature work']);

  writeFileSync(path.join(repoRoot, 'shared.txt'), 'base\nmain\n');
  git(repoRoot, ['add', 'shared.txt']);
  git(repoRoot, ['commit', '-m', 'main work']);

  const prompts: string[] = [];
  const agentProvider = new FakeAgentExecutionProvider(async (request) => {
    prompts.push(request.prompt);
    writeFileSync(path.join(repoRoot, 'shared.txt'), 'base\nfeature\nmain\n');
    git(repoRoot, ['add', 'shared.txt']);
    return { status: 'completed', sessionId: null, removable: true, output: ['resolved'] };
  });

  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: agentProvider,
    runtimeStore: new RuntimeStore({ repoRoot }),
  });

  const result = await coordinator.mergeFeatureBranchToBase({
    repoRoot,
    baseBranch: 'main',
    featureBranch: feature,
    feature,
    model: { id: 'model-1' },
  });

  assert.equal(result.success, true);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Attempt: 1 of 50/);
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

test('describes unmerged index state when conflict markers are gone', async () => {
  const repoRoot = createRepo('merge-back-unmerged-index-');
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
  const prompts: string[] = [];

  const agentProvider = new FakeAgentExecutionProvider(async (request) => {
    prompts.push(request.prompt);
    if (prompts.length === 1) {
      writeFileSync(path.join(featureWorktreePath, 'shared.txt'), 'base\nbranch1\nbranch2\n');
    }
    return { status: 'completed', sessionId: null, removable: true, output: ['not staged'] };
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
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Unmerged index entries \(git diff --name-only --diff-filter=U\):\n\n- shared\.txt/);
  assert.match(prompts[1], /Conflict markers remain: no/);
  assert.match(prompts[1], /unresolved Git index state/);

  const metadata2 = store.readMetadata(meta2.metadataPath);
  assert.deepEqual(metadata2.MERGE_CONFLICT_PATHS, ['shared.txt']);
  assert.equal(metadata2.MERGE_FINAL_DIAGNOSTICS?.markersRemain, false);
  assert.deepEqual(metadata2.MERGE_FINAL_DIAGNOSTICS?.unmergedIndexPaths, ['shared.txt']);
  assert.match(metadata2.MERGE_FINAL_DIAGNOSTICS?.summary ?? '', /unresolved Git index state/);
  assert.match(readFileSync(meta2.logPath, 'utf8'), /"unmergedIndexPaths":\["shared.txt"\]/);
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

test('reports branch deletion failure as warning debt when merge proof succeeded', async () => {
  const repoRoot = createRepo('merge-back-branch-delete-warning-');
  const feature = 'feat-a';
  const featureWorktreePath = createFeatureWorktree(repoRoot, feature);

  const scratch = createScratchWorktree(repoRoot, feature, '001', feature);
  writeFileSync(path.join(scratch.worktreePath, 'a.txt'), 'a\n');
  git(scratch.worktreePath, ['add', 'a.txt']);
  git(scratch.worktreePath, ['commit', '-m', 'ticket-001']);

  // Create a second worktree for the same branch to block branch deletion
  const scratch2WorktreePath = path.join(repoRoot, '.worktree', `${feature}-001-copy`);
  git(repoRoot, ['worktree', 'add', '--force', scratch2WorktreePath, scratch.branchName]);

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
  assert.equal(result.failedTickets.length, 0);
  assert.equal(result.cleanupResults.length, 1);
  assert.equal(result.cleanupResults[0].success, false);
  assert.equal(result.cleanupResults[0].deletedWorktree, true);
  assert.equal(result.cleanupResults[0].deletedBranch, false);
  assert.ok(result.cleanupResults[0].error);
  assert.ok(
    result.cleanupResults[0].error?.includes('branch delete failed') ||
      result.cleanupResults[0].error?.includes('cannot delete branch'),
  );

  // Verify the warning was persisted for later visibility
  const pendingPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'pending-post-merge-cleanup.json');
  const pending = JSON.parse(readFileSync(pendingPath, 'utf8')) as Array<{ issueName: string; error?: string }>;
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.issueName, '001');
  assert.ok(pending[0]?.error);
});

test('merges feature to base and reports cleanup warning when branch deletion fails', async () => {
  const repoRoot = createRepo('feature-base-merge-cleanup-warning-');
  const feature = 'feat-a';
  const featureWorktreePath = createFeatureWorktree(repoRoot, feature);
  writeFileSync(path.join(featureWorktreePath, 'feature.txt'), 'feature\n');
  git(featureWorktreePath, ['add', 'feature.txt']);
  git(featureWorktreePath, ['commit', '-m', 'feature work']);

  // Create a second worktree checked out on the feature branch to block branch deletion
  const secondWorktreePath = path.join(repoRoot, '.worktree', `${feature}-copy`);
  git(repoRoot, ['worktree', 'add', '--force', secondWorktreePath, feature]);

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
  assert.equal(results[0]?.deletedWorktree, true);
  assert.equal(results[0]?.deletedBranch, false);
  assert.ok(results[0]?.warning);
  assert.ok(
    results[0]?.warning?.includes('branch delete failed') || results[0]?.warning?.includes('cannot delete branch'),
  );
  assert.equal(git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  assert.equal(readFileSync(path.join(repoRoot, 'feature.txt'), 'utf8'), 'feature\n');
  assert.equal(existsSync(featureWorktreePath), false);
  // Feature branch should still exist because deletion was blocked
  assert.doesNotThrow(() => git(repoRoot, ['rev-parse', '--verify', feature]));
});
test('serializes concurrent base merge invocations for the same repo', async () => {
  const repoRoot = createRepo('concurrent-base-merge-');
  const featureA = 'feat-a';
  const featureB = 'feat-b';
  const featureWorktreePathA = createFeatureWorktree(repoRoot, featureA);
  const featureWorktreePathB = createFeatureWorktree(repoRoot, featureB);

  writeFileSync(path.join(featureWorktreePathA, 'a.txt'), 'a\n');
  git(featureWorktreePathA, ['add', 'a.txt']);
  git(featureWorktreePathA, ['commit', '-m', 'feature-a work']);

  writeFileSync(path.join(featureWorktreePathB, 'b.txt'), 'b\n');
  git(featureWorktreePathB, ['add', 'b.txt']);
  git(featureWorktreePathB, ['commit', '-m', 'feature-b work']);

  const store = new RuntimeStore({ repoRoot });
  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: new FakeAgentExecutionProvider({ status: 'completed', sessionId: null, removable: true }),
    runtimeStore: store,
  });

  const activeMerges = new Set<string>();
  let overlap = false;

  const originalMerge = coordinator.mergeFeatureBranchToBase.bind(coordinator);
  coordinator.mergeFeatureBranchToBase = async (input) => {
    if (activeMerges.size > 0) overlap = true;
    activeMerges.add(input.feature);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await originalMerge(input);
    activeMerges.delete(input.feature);
    return result;
  };

  const lock = new BaseMergeLock();

  const promiseA = mergeCompletedFeaturesToBase({
    repoRoot,
    baseBranch: 'main',
    features: [featureA],
    checkoutsByFeature: {
      [featureA]: {
        featureSlug: featureA,
        defaultWorktreeName: featureA,
        effectiveWorktreeName: featureA,
        defaultBranchName: featureA,
        effectiveBranchName: featureA,
        worktreePath: featureWorktreePathA,
      },
    },
    coordinator,
    model: { id: 'model-1' },
    baseMergeLock: lock,
  });

  const promiseB = mergeCompletedFeaturesToBase({
    repoRoot,
    baseBranch: 'main',
    features: [featureB],
    checkoutsByFeature: {
      [featureB]: {
        featureSlug: featureB,
        defaultWorktreeName: featureB,
        effectiveWorktreeName: featureB,
        defaultBranchName: featureB,
        effectiveBranchName: featureB,
        worktreePath: featureWorktreePathB,
      },
    },
    coordinator,
    model: { id: 'model-1' },
    baseMergeLock: lock,
  });

  await Promise.all([promiseA, promiseB]);
  assert.equal(overlap, false, 'base merge invocations overlapped');
});

test('emits waiting progress when a feature is queued for base merge', async () => {
  const repoRoot = createRepo('base-merge-waiting-msg-');
  const featureA = 'feat-a';
  const featureB = 'feat-b';
  const featureWorktreePathA = createFeatureWorktree(repoRoot, featureA);
  const featureWorktreePathB = createFeatureWorktree(repoRoot, featureB);

  writeFileSync(path.join(featureWorktreePathA, 'a.txt'), 'a\n');
  git(featureWorktreePathA, ['add', 'a.txt']);
  git(featureWorktreePathA, ['commit', '-m', 'feature-a work']);

  writeFileSync(path.join(featureWorktreePathB, 'b.txt'), 'b\n');
  git(featureWorktreePathB, ['add', 'b.txt']);
  git(featureWorktreePathB, ['commit', '-m', 'feature-b work']);

  const store = new RuntimeStore({ repoRoot });
  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: new FakeAgentExecutionProvider({ status: 'completed', sessionId: null, removable: true }),
    runtimeStore: store,
  });

  const progressEvents: Array<{ ticketLabel: string; message: string }> = [];

  const originalMerge = coordinator.mergeFeatureBranchToBase.bind(coordinator);
  coordinator.mergeFeatureBranchToBase = async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return originalMerge(input);
  };

  const lock = new BaseMergeLock();

  const promiseA = mergeCompletedFeaturesToBase({
    repoRoot,
    baseBranch: 'main',
    features: [featureA],
    checkoutsByFeature: {
      [featureA]: {
        featureSlug: featureA,
        defaultWorktreeName: featureA,
        effectiveWorktreeName: featureA,
        defaultBranchName: featureA,
        effectiveBranchName: featureA,
        worktreePath: featureWorktreePathA,
      },
    },
    coordinator,
    model: { id: 'model-1' },
    baseMergeLock: lock,
    onProgress: (event) => progressEvents.push({ ticketLabel: event.ticketLabel, message: event.message }),
  });

  const promiseB = mergeCompletedFeaturesToBase({
    repoRoot,
    baseBranch: 'main',
    features: [featureB],
    checkoutsByFeature: {
      [featureB]: {
        featureSlug: featureB,
        defaultWorktreeName: featureB,
        effectiveWorktreeName: featureB,
        defaultBranchName: featureB,
        effectiveBranchName: featureB,
        worktreePath: featureWorktreePathB,
      },
    },
    coordinator,
    model: { id: 'model-1' },
    baseMergeLock: lock,
    onProgress: (event) => progressEvents.push({ ticketLabel: event.ticketLabel, message: event.message }),
  });

  await Promise.all([promiseA, promiseB]);

  const waitingEvent = progressEvents.find(
    (e) => e.message.includes('waiting for another feature') && e.ticketLabel === `${featureB}/base-merge`,
  );
  assert.ok(waitingEvent, 'Expected waiting progress event for second feature');
});

test('default module lock serializes concurrent base merges when no lock is provided', async () => {
  const repoRoot = createRepo('default-lock-base-merge-');
  const featureA = 'feat-a';
  const featureB = 'feat-b';
  const featureWorktreePathA = createFeatureWorktree(repoRoot, featureA);
  const featureWorktreePathB = createFeatureWorktree(repoRoot, featureB);

  writeFileSync(path.join(featureWorktreePathA, 'a.txt'), 'a\n');
  git(featureWorktreePathA, ['add', 'a.txt']);
  git(featureWorktreePathA, ['commit', '-m', 'feature-a work']);

  writeFileSync(path.join(featureWorktreePathB, 'b.txt'), 'b\n');
  git(featureWorktreePathB, ['add', 'b.txt']);
  git(featureWorktreePathB, ['commit', '-m', 'feature-b work']);

  const store = new RuntimeStore({ repoRoot });
  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: new FakeAgentExecutionProvider({ status: 'completed', sessionId: null, removable: true }),
    runtimeStore: store,
  });

  const activeMerges = new Set<string>();
  let overlap = false;

  const originalMerge = coordinator.mergeFeatureBranchToBase.bind(coordinator);
  coordinator.mergeFeatureBranchToBase = async (input) => {
    if (activeMerges.size > 0) overlap = true;
    activeMerges.add(input.feature);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await originalMerge(input);
    activeMerges.delete(input.feature);
    return result;
  };

  // Do not pass baseMergeLock — should use module-level default
  const promiseA = mergeCompletedFeaturesToBase({
    repoRoot,
    baseBranch: 'main',
    features: [featureA],
    checkoutsByFeature: {
      [featureA]: {
        featureSlug: featureA,
        defaultWorktreeName: featureA,
        effectiveWorktreeName: featureA,
        defaultBranchName: featureA,
        effectiveBranchName: featureA,
        worktreePath: featureWorktreePathA,
      },
    },
    coordinator,
    model: { id: 'model-1' },
  });

  const promiseB = mergeCompletedFeaturesToBase({
    repoRoot,
    baseBranch: 'main',
    features: [featureB],
    checkoutsByFeature: {
      [featureB]: {
        featureSlug: featureB,
        defaultWorktreeName: featureB,
        effectiveWorktreeName: featureB,
        defaultBranchName: featureB,
        effectiveBranchName: featureB,
        worktreePath: featureWorktreePathB,
      },
    },
    coordinator,
    model: { id: 'model-1' },
  });

  await Promise.all([promiseA, promiseB]);
  assert.equal(overlap, false, 'default module lock failed to serialize base merges');
});
