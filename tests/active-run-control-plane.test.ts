import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ActiveRunControlPlane } from '../src/active-run-control-plane.js';
import { mkRepoLocalTempDir } from './helpers/temp-repo.js';

test('acquireOrAttach starts a run when no active record exists', () => {
  const repoRoot = mkRepoLocalTempDir('active-run-start-');
  const controlPlane = new ActiveRunControlPlane({ repoRoot, now: () => 1_000, pid: process.pid });

  const result = controlPlane.acquireOrAttach('run-1');
  assert.equal(result.action, 'started');
  assert.equal(result.record.runId, 'run-1');
  assert.equal(result.record.state, 'starting');

  const statePath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'active-run.json');
  const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as { runId: string };
  assert.equal(persisted.runId, 'run-1');
});

test('acquireOrAttach attaches while active run is healthy', () => {
  const repoRoot = mkRepoLocalTempDir('active-run-attach-');
  const statePath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'active-run.json');
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify({
      version: 1,
      runId: 'run-existing',
      pid: process.pid,
      startedAt: new Date(1_000).toISOString(),
      heartbeatAt: new Date(1_500).toISOString(),
      state: 'running',
      command: 'afk',
    })}\n`,
    'utf8',
  );
  const controlPlane = new ActiveRunControlPlane({
    repoRoot,
    now: () => 2_000,
    pid: process.pid,
    staleHeartbeatMs: 5_000,
  });

  const result = controlPlane.acquireOrAttach('run-new');
  assert.equal(result.action, 'attached');
  assert.equal(result.record.runId, 'run-existing');
});

test('acquireOrAttach reclaims stale lock with expired heartbeat', () => {
  const repoRoot = mkRepoLocalTempDir('active-run-stale-');
  const statePath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'active-run.json');
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify({
      version: 1,
      runId: 'run-old',
      pid: process.pid,
      startedAt: new Date(1_000).toISOString(),
      heartbeatAt: new Date(1_001).toISOString(),
      state: 'running',
      command: 'afk',
    })}\n`,
    'utf8',
  );
  const controlPlane = new ActiveRunControlPlane({
    repoRoot,
    now: () => 100_000,
    pid: process.pid,
    staleHeartbeatMs: 1_000,
  });

  const result = controlPlane.acquireOrAttach('run-new');
  assert.equal(result.action, 'started');
  assert.equal(result.staleReclaimed, true);
  assert.equal(result.record.runId, 'run-new');
});

test('transition and clear update lifecycle then release lock', () => {
  const repoRoot = mkRepoLocalTempDir('active-run-lifecycle-');
  const controlPlane = new ActiveRunControlPlane({ repoRoot, now: () => 10_000, pid: process.pid });
  const started = controlPlane.acquireOrAttach('run-1');
  assert.equal(started.action, 'started');

  controlPlane.transition('run-1', 'paused');
  assert.equal(controlPlane.read()?.state, 'paused');
  controlPlane.transition('run-1', 'killing');
  assert.equal(controlPlane.read()?.state, 'killing');
  controlPlane.clear('run-1');
  assert.equal(controlPlane.read(), null);
});
