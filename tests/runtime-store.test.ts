import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RuntimeStore } from '../src/runtime-store.js';

test('creates metadata, appends logs, and writes sentinels', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runtime-'));
  const store = new RuntimeStore({ repoRoot });
  const record = store.createRecord({ featureSlug: 'feat', issueName: '001', ticketPath: '/tmp/ticket.md' });
  store.appendLog(record.logPath, 'hello');
  store.updateMetadata(record.metadataPath, { STATUS: 'completed', PROVIDER_SESSION_ID: 'session-1', PROVIDER_SESSION_REMOVABLE: true, UNSAFE_REASON: null });
  store.markDone(record);
  store.markFailed(record, 'failed');

  const metadata = JSON.parse(readFileSync(record.metadataPath, 'utf8')) as Record<string, unknown>;
  assert.equal(metadata.TICKET_PATH, '/tmp/ticket.md');
  assert.equal(metadata.STATUS, 'completed');
  assert.equal(metadata.PROVIDER_SESSION_ID, 'session-1');
  assert.equal(existsSync(record.doneSentinelPath), true);
  assert.equal(existsSync(record.failedSentinelPath), true);
  assert.match(readFileSync(record.logPath, 'utf8'), /hello/);
  assert.match(readFileSync(record.doneSentinelPath, 'utf8'), /done/);
  assert.match(readFileSync(record.failedSentinelPath, 'utf8'), /failed/);
});

test('reads empty launch preferences when missing or malformed', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runtime-'));
  const store = new RuntimeStore({ repoRoot });
  assert.deepEqual(store.readLaunchPreferences(), {});

  const preferencesPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'launch-preferences.json');
  mkdirSync(path.dirname(preferencesPath), { recursive: true });
  writeFileSync(preferencesPath, 'not json', 'utf8');
  assert.deepEqual(store.readLaunchPreferences(), {});
});

test('round-trips launch preferences', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runtime-'));
  const store = new RuntimeStore({ repoRoot });
  store.writeLaunchPreferences({ harness: 'OpenCode', modelId: 'provider/exec', reviewerModelId: 'provider/review' });

  assert.deepEqual(store.readLaunchPreferences(), {
    harness: 'OpenCode',
    modelId: 'provider/exec',
    reviewerModelId: 'provider/review',
  });
});

test('reads optional budget preferences', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runtime-'));
  const store = new RuntimeStore({ repoRoot });
  store.writeLaunchPreferences({
    harness: 'OpenCode',
    budgets: {
      malformedReviewerRetries: 1,
      fixupCycleLimit: 3,
      providerFailureRetries: 0,
      ticketWallClockMs: 1000,
      phaseWallClockMs: { execution: 500 },
    },
  });

  assert.deepEqual(store.readLaunchPreferences().budgets, {
    malformedReviewerRetries: 1,
    fixupCycleLimit: 3,
    providerFailureRetries: 0,
    ticketWallClockMs: 1000,
    phaseWallClockMs: { execution: 500 },
  });
});

test('records phase history with deterministic timing', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runtime-'));
  let tick = 0;
  const store = new RuntimeStore({ repoRoot, now: () => tick++ * 10 });
  const record = store.createRecord({ featureSlug: 'feat', issueName: 'phase', ticketPath: '/tmp/ticket.md' });

  await store.runPhase(record.metadataPath, record.logPath, 'execution', async () => {
    await Promise.resolve();
  }, 1);

  const metadata = JSON.parse(readFileSync(record.metadataPath, 'utf8')) as Record<string, unknown>;
  const phases = metadata.PHASE_HISTORY as Array<Record<string, unknown>>;
  assert.equal(phases.length, 1);
  assert.equal(phases[0].name, 'execution');
  assert.equal(phases[0].durationMs, 10);
  assert.equal(phases[0].cycle, 1);
});

test('records phase history when phase action throws', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runtime-'));
  let tick = 0;
  const store = new RuntimeStore({ repoRoot, now: () => tick++ * 5 });
  const record = store.createRecord({ featureSlug: 'feat', issueName: 'phase-fail', ticketPath: '/tmp/ticket.md' });

  await assert.rejects(
    store.runPhase(record.metadataPath, record.logPath, 'review', async () => {
      throw new Error('boom');
    }, 2),
    /boom/,
  );

  const metadata = JSON.parse(readFileSync(record.metadataPath, 'utf8')) as Record<string, unknown>;
  const phases = metadata.PHASE_HISTORY as Array<Record<string, unknown>>;
  assert.equal(phases.length, 1);
  assert.equal(phases[0].name, 'review');
  assert.equal(phases[0].durationMs, 5);
  assert.equal(phases[0].cycle, 2);
});
