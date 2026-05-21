import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RuntimeStore } from '../src/runtime-store.js';

test('creates metadata, appends logs, and writes sentinels', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runtime-'));
  const store = new RuntimeStore({ repoRoot });
  const record = store.createRecord({ featureSlug: 'feat', issueName: '001', ticketPath: '/tmp/ticket.md' });
  store.appendLog(record.logPath, 'hello');
  store.updateMetadata(record.metadataPath, {
    STATUS: 'completed',
    PROVIDER_SESSION_ID: 'session-1',
    PROVIDER_SESSION_REMOVABLE: true,
    UNSAFE_REASON: null,
  });
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

  await store.runPhase(
    record.metadataPath,
    record.logPath,
    'execution',
    async () => {
      await Promise.resolve();
    },
    1,
  );

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
    store.runPhase(
      record.metadataPath,
      record.logPath,
      'review',
      async () => {
        throw new Error('boom');
      },
      2,
    ),
    /boom/,
  );

  const metadata = JSON.parse(readFileSync(record.metadataPath, 'utf8')) as Record<string, unknown>;
  const phases = metadata.PHASE_HISTORY as Array<Record<string, unknown>>;
  assert.equal(phases.length, 1);
  assert.equal(phases[0].name, 'review');
  assert.equal(phases[0].durationMs, 5);
  assert.equal(phases[0].cycle, 2);
});

test('rejects runtime artifact path escapes outside log root', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runtime-path-safety-'));
  const store = new RuntimeStore({ repoRoot });
  const record = store.createRecord({ featureSlug: '..', issueName: 'escape', ticketPath: '/tmp/ticket.md' });

  assert.throws(() => store.appendLog(path.join(repoRoot, '..', 'escape.log'), 'boom'), /Invalid runtime log path/);
  assert.throws(
    () => store.updateMetadata(path.join(repoRoot, '..', 'escape.json'), { STATUS: 'failed' }),
    /Invalid runtime metadata path/,
  );
  assert.throws(
    () => store.markDone({ ...record, doneSentinelPath: path.join(repoRoot, '..', 'done.sentinel') }),
    /Invalid done sentinel path/,
  );
  assert.throws(
    () => store.markFailed({ ...record, failedSentinelPath: path.join(repoRoot, '..', 'failed.sentinel') }, 'failed'),
    /Invalid failed sentinel path/,
  );
});

test('records review outcome metadata with additive classification fields', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runtime-review-metadata-'));
  const store = new RuntimeStore({ repoRoot });
  const record = store.createRecord({ featureSlug: 'feat', issueName: 'review', ticketPath: '/tmp/ticket.md' });

  store.recordReviewCycle(record.metadataPath, record.logPath, {
    cycle: 1,
    outcome: 'approve',
    reason: 'No findings',
    malformed: false,
    findings: [],
    classification: 'clean-approval',
  });
  store.recordFinalReviewOutcome(record.metadataPath, record.logPath, {
    outcome: 'approved',
    reason: 'No findings',
    cycle: 1,
    classification: 'clean-approval',
    malformed: false,
    findings: [],
  });

  const metadata = JSON.parse(readFileSync(record.metadataPath, 'utf8')) as Record<string, unknown>;
  assert.equal(metadata.FINAL_REVIEW_CLASSIFICATION, 'clean-approval');
  assert.equal(metadata.FINAL_REVIEW_MALFORMED, false);
  assert.deepEqual(metadata.FINAL_REVIEW_FINDINGS, []);
});

test('keeps metadata readers compatible when new review fields are absent', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runtime-review-compat-'));
  const store = new RuntimeStore({ repoRoot });
  const record = store.createRecord({ featureSlug: 'feat', issueName: 'compat', ticketPath: '/tmp/ticket.md' });
  const metadataPath = record.metadataPath;
  const legacy = {
    TICKET_PATH: '/tmp/ticket.md',
    FEATURE_SLUG: 'feat',
    ISSUE_NAME: 'compat',
    LOG_PATH: record.logPath,
    START_TIME: new Date().toISOString(),
    START_EPOCH: Date.now(),
    DONE_SENTINEL_PATH: record.doneSentinelPath,
    FAILED_SENTINEL_PATH: record.failedSentinelPath,
    STATUS: 'completed',
    EXECUTION_PROVIDER: 'opencode',
    PROVIDER_SESSION_ID: null,
    PROVIDER_SESSION_REMOVABLE: false,
    INSPECTION_PROVIDER: null,
    INSPECTION_TARGET_IDENTIFIER: null,
    FAILURE_KIND: null,
    UNSAFE_REASON: null,
  };
  writeFileSync(metadataPath, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

  const metadata = store.readMetadata(metadataPath);
  assert.equal(metadata.STATUS, 'completed');
  assert.equal(metadata.FINAL_REVIEW_CLASSIFICATION, undefined);
  assert.equal(metadata.FINAL_REVIEW_MALFORMED_OUTPUT_SNIPPET, undefined);
});
