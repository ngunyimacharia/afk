import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runAfk } from '../src/cli.js';

test('afk-cleanup executes cleanup without confirmation phrase', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  const sentinelsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'sentinels');
  const workspaceExecutionPath = path.join(repoRoot, '.scratch', 'execution.json');
  mkdirSync(issuesDir, { recursive: true });
  mkdirSync(sentinelsDir, { recursive: true });
  const ticketPath = path.join(issuesDir, 'done.md');
  const sentinelPath = path.join(sentinelsDir, 'feat-done.done');
  writeFileSync(ticketPath, '---\nstatus: done\n---\n');
  writeFileSync(sentinelPath, 'done');
  writeFileSync(workspaceExecutionPath, '{"state":"running"}\n');
  const originalArg = process.argv[2];
  process.argv[2] = 'afk-cleanup';
  const result = await runAfk(repoRoot);
  process.argv[2] = originalArg;
  assert.match(result.message, /AFK Cleanup Plan/);
  assert.match(result.message, /Executed:/);
  assert.equal(existsSync(ticketPath), false);
  assert.equal(existsSync(sentinelPath), false);
  assert.equal(existsSync(workspaceExecutionPath), false);
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

test('afk-cleanup --dry-run prints plan without deleting files', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  const sentinelsDir = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'sentinels');
  const workspaceExecutionPath = path.join(repoRoot, '.scratch', 'execution.json');
  mkdirSync(issuesDir, { recursive: true });
  mkdirSync(sentinelsDir, { recursive: true });
  const ticketPath = path.join(issuesDir, 'done.md');
  const sentinelPath = path.join(sentinelsDir, 'feat-done.done');
  writeFileSync(ticketPath, '---\nstatus: done\n---\n');
  writeFileSync(sentinelPath, 'done');
  writeFileSync(workspaceExecutionPath, '{"state":"running"}\n');

  const originalArgs = [...process.argv];
  process.argv[2] = 'afk-cleanup';
  process.argv[3] = '--dry-run';
  const result = await runAfk(repoRoot);
  process.argv = originalArgs;

  assert.match(result.message, /AFK Cleanup Plan/);
  assert.match(result.message, /Dry run only\. No files were deleted\./);
  assert.doesNotMatch(result.message, /Executed:/);
  assert.equal(existsSync(ticketPath), true);
  assert.equal(existsSync(sentinelPath), true);
  assert.equal(existsSync(workspaceExecutionPath), true);
});
