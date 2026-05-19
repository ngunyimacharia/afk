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
