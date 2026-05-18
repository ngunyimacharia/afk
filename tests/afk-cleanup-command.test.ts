import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runAfk } from '../src/cli.js';

test('afk-cleanup shows dry-run first and requires explicit confirmation phrase', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  const ticketPath = path.join(issuesDir, 'done.md');
  writeFileSync(ticketPath, '---\nstatus: done\n---\n');
  const originalArg = process.argv[2];
  process.argv[2] = 'afk-cleanup';
  const dryRun = await runAfk(repoRoot);
  assert.match(dryRun.message, /AFK Cleanup Plan/);
  assert.match(dryRun.message, /confirm cleanup plan/);
  assert.equal(existsSync(ticketPath), true);
  const confirmed = await runAfk(repoRoot);
  process.argv[2] = originalArg;
  assert.match(confirmed.message, /AFK Cleanup Plan/);
});

test('cleanup preserves ready-for-human tickets', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  const ticketPath = path.join(issuesDir, 'human.md');
  writeFileSync(ticketPath, '---\nstatus: ready-for-human\n---\n');
  const originalArg = process.argv[2];
  process.argv[2] = 'afk-cleanup';
  const result = await runAfk(repoRoot);
  process.argv[2] = originalArg;
  assert.match(result.message, /human\.md/);
  assert.equal(existsSync(ticketPath), true);
});
