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

test('rejects runtime artifact path escapes outside log root', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-runtime-path-safety-'));
  const store = new RuntimeStore({ repoRoot });
  const record = store.createRecord({ featureSlug: '..', issueName: 'escape', ticketPath: '/tmp/ticket.md' });

  assert.throws(() => store.appendLog(path.join(repoRoot, '..', 'escape.log'), 'boom'), /Invalid runtime log path/);
  assert.throws(() => store.updateMetadata(path.join(repoRoot, '..', 'escape.json'), { STATUS: 'failed' }), /Invalid runtime metadata path/);
  assert.throws(() => store.markDone({ ...record, doneSentinelPath: path.join(repoRoot, '..', 'done.sentinel') }), /Invalid done sentinel path/);
  assert.throws(() => store.markFailed({ ...record, failedSentinelPath: path.join(repoRoot, '..', 'failed.sentinel') }, 'failed'), /Invalid failed sentinel path/);
});
