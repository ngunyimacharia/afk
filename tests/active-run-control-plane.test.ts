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
  const controlPlane = new ActiveRunControlPlane({ repoRoot, now: () => 2_000, pid: process.pid, staleHeartbeatMs: 5_000 });

  const result = controlPlane.acquireOrAttach('run-new');
  assert.equal(result.action, 'attached');
  assert.equal(result.record.runId, 'run-existing');
});

test('acquireOrAttach recovers stale lock with dead PID', () => {
  const repoRoot = mkRepoLocalTempDir('active-run-dead-pid-');
  const statePath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'active-run.json');
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify({
      version: 1,
      runId: 'run-dead',
      pid: 999_999,
      startedAt: new Date(1_000).toISOString(),
      heartbeatAt: new Date(90_000).toISOString(),
      state: 'paused',
      command: 'afk',
    })}\n`,
    'utf8',
  );
  const controlPlane = new ActiveRunControlPlane({ repoRoot, now: () => 100_000, pid: process.pid, staleHeartbeatMs: 5_000 });

  const result = controlPlane.acquireOrAttach('run-new');
  assert.equal(result.action, 'recovered');
  assert.equal(result.record.runId, 'run-dead');
  assert.equal(result.previousRecord.pid, 999_999);
  assert.match(result.recoveryMessage, /previous PID 999999 dead/);
  assert.match(result.recoveryMessage, /state was paused/);
});

test('acquireOrAttach recovers stale lock with expired heartbeat', () => {
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
  const controlPlane = new ActiveRunControlPlane({ repoRoot, now: () => 100_000, pid: process.pid, staleHeartbeatMs: 1_000 });

  const result = controlPlane.acquireOrAttach('run-new');
  assert.equal(result.action, 'recovered');
  assert.equal(result.record.runId, 'run-old');
  assert.equal(result.previousRecord.runId, 'run-old');
  assert.match(result.recoveryMessage, /previous PID .* dead/);
  assert.match(result.recoveryMessage, /state was running/);
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

test('enqueueCommand and readCommands append and poll commands', () => {
  const repoRoot = mkRepoLocalTempDir('active-run-commands-');
  const controlPlane = new ActiveRunControlPlane({ repoRoot, now: () => 20_000, pid: process.pid });
  controlPlane.acquireOrAttach('run-1');

  controlPlane.enqueueCommand('run-1', { type: 'pause', clientPid: 123 });
  controlPlane.enqueueCommand('run-1', { type: 'resume', clientPid: 456 });

  const firstRead = controlPlane.readCommands('run-1', 0);
  assert.equal(firstRead.commands.length, 2);
  assert.equal(firstRead.commands[0]?.type, 'pause');
  assert.equal(firstRead.commands[1]?.type, 'resume');

  const secondRead = controlPlane.readCommands('run-1', firstRead.nextOffset);
  assert.equal(secondRead.commands.length, 0);
});

test('enqueueCommand ignores wrong runId', () => {
  const repoRoot = mkRepoLocalTempDir('active-run-commands-wrong-');
  const controlPlane = new ActiveRunControlPlane({ repoRoot, now: () => 20_000, pid: process.pid });
  controlPlane.acquireOrAttach('run-1');

  controlPlane.enqueueCommand('run-2', { type: 'pause', clientPid: 123 });

  const result = controlPlane.readCommands('run-1', 0);
  assert.equal(result.commands.length, 0);
});

test('clearCommands removes command file', () => {
  const repoRoot = mkRepoLocalTempDir('active-run-commands-clear-');
  const controlPlane = new ActiveRunControlPlane({ repoRoot, now: () => 20_000, pid: process.pid });
  controlPlane.acquireOrAttach('run-1');
  controlPlane.enqueueCommand('run-1', { type: 'pause', clientPid: 123 });

  controlPlane.clearCommands('run-1');
  const result = controlPlane.readCommands('run-1', 0);
  assert.equal(result.commands.length, 0);
});

test('recovery clears stale commands from previous run', () => {
  const repoRoot = mkRepoLocalTempDir('active-run-recovery-clears-commands-');
  const controlPlane = new ActiveRunControlPlane({ repoRoot, now: () => 20_000, pid: process.pid });
  controlPlane.acquireOrAttach('run-old');
  controlPlane.enqueueCommand('run-old', { type: 'pause', clientPid: 123 });

  // Simulate stale run by moving time forward
  const staleControlPlane = new ActiveRunControlPlane({
    repoRoot,
    now: () => 200_000,
    pid: process.pid,
    staleHeartbeatMs: 1_000,
  });
  const result = staleControlPlane.acquireOrAttach('run-new');
  assert.equal(result.action, 'recovered');

  const commands = staleControlPlane.readCommands('run-old', 0);
  assert.equal(commands.commands.length, 0);
});

test('recovery preserves startedAt and updates pid', () => {
  const repoRoot = mkRepoLocalTempDir('active-run-recovery-preserve-start-');
  const statePath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'active-run.json');
  mkdirSync(path.dirname(statePath), { recursive: true });
  const startedAt = new Date(1_000).toISOString();
  writeFileSync(
    statePath,
    `${JSON.stringify({
      version: 1,
      runId: 'run-old',
      pid: 999_999,
      startedAt,
      heartbeatAt: new Date(1_001).toISOString(),
      state: 'running',
      command: 'afk',
    })}\n`,
    'utf8',
  );
  const controlPlane = new ActiveRunControlPlane({ repoRoot, now: () => 100_000, pid: process.pid, staleHeartbeatMs: 1_000 });

  const result = controlPlane.acquireOrAttach('run-new');
  assert.equal(result.action, 'recovered');
  assert.equal(result.record.startedAt, startedAt);
  assert.equal(result.record.pid, process.pid);
});
