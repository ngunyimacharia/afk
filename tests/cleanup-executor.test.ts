import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CleanupExecutor } from '../src/cleanup.js';

test('executes only approved cleanup targets', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuePath = path.join(repoRoot, '.scratch', 'feat', 'issues', 'done.md');
  const logPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-done.log');
  mkdirSync(path.dirname(issuePath), { recursive: true });
  mkdirSync(path.dirname(logPath), { recursive: true });
  writeFileSync(issuePath, 'x');
  writeFileSync(logPath, 'x');
  const result = new CleanupExecutor().execute({
    terminalTargets: [{ feature: 'feat', issueName: 'done', issuePath, logPath, reason: 'done' }],
    preservedIssues: [],
    preservedArtifacts: [],
    featureDirectoriesToDelete: [],
  });
  assert.equal(existsSync(issuePath), false);
  assert.equal(existsSync(logPath), false);
  assert.equal(result.deleted.length >= 2, true);
});
