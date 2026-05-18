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
  assert.deepEqual(metadata.REVIEW_CYCLE_HISTORY, []);
  assert.equal(metadata.FINAL_REVIEW_OUTCOME, null);
  assert.equal(existsSync(record.doneSentinelPath), true);
  assert.equal(existsSync(record.failedSentinelPath), true);
  assert.match(readFileSync(record.logPath, 'utf8'), /hello/);
  assert.match(readFileSync(record.doneSentinelPath, 'utf8'), /done/);
  assert.match(readFileSync(record.failedSentinelPath, 'utf8'), /failed/);
});

test('reads legacy runtime metadata without the new review fields', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runtime-legacy-'));
  const store = new RuntimeStore({ repoRoot });
  const metadataPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'feat-001.json');
  mkdirSync(path.dirname(metadataPath), { recursive: true });
  writeFileSync(metadataPath, JSON.stringify({
    TICKET_PATH: '/tmp/ticket.md',
    FEATURE_SLUG: 'feat',
    ISSUE_NAME: '001',
    LOG_PATH: '/tmp/feat-001.log',
    START_TIME: '2026-05-18T00:00:00.000Z',
    START_EPOCH: 1,
    DONE_SENTINEL_PATH: '/tmp/feat-001.done',
    FAILED_SENTINEL_PATH: '/tmp/feat-001.failed',
    STATUS: 'completed',
    EXECUTION_PROVIDER: 'opencode',
    PROVIDER_SESSION_ID: null,
    PROVIDER_SESSION_REMOVABLE: false,
    INSPECTION_PROVIDER: null,
    INSPECTION_TARGET_IDENTIFIER: null,
    UNSAFE_REASON: null,
  }), 'utf8');

  const metadata = store.updateMetadata(metadataPath, {
    REVIEW_CYCLE_HISTORY: [{ cycle: 1, outcome: 'approve', reason: 'ok', malformed: false, findings: [] }],
    FINAL_REVIEW_OUTCOME: 'approved',
    FINAL_REVIEW_REASON: 'ok',
    FINAL_REVIEW_CYCLE: 1,
  });

  assert.equal(metadata.REVIEW_CYCLE_HISTORY?.length, 1);
  assert.equal(metadata.FINAL_REVIEW_OUTCOME, 'approved');
  assert.equal(metadata.STATUS, 'completed');
});
