import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildFeatureExecutionGraph } from '../src/feature-execution-graph.js';
import { TicketRepository } from '../src/ticket-repository.js';

test('builds ready and blocked waves from dependencies', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(path.join(issuesDir, '01.md'), '---\nfeature: feat\nstatus: ready-for-agent\n---\n');
  writeFileSync(
    path.join(issuesDir, '02.md'),
    '---\nfeature: feat\nstatus: ready-for-agent\nDepends-On:\n  - 01\n---\n',
  );
  const repository = new TicketRepository(repoRoot);
  const graph = buildFeatureExecutionGraph(repoRoot, 'feat', repository.discoverTickets(), false);
  assert.equal(graph.tickets['01'].state, 'ready');
  assert.equal(graph.tickets['02'].state, 'blocked');
  assert.deepEqual(graph.waves[0], ['01']);
});

test('rejects missing dependency references', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(
    path.join(issuesDir, '01.md'),
    '---\nfeature: feat\nstatus: ready-for-agent\nDepends-On:\n  - 99\n---\n',
  );
  const repository = new TicketRepository(repoRoot);
  assert.throws(
    () => buildFeatureExecutionGraph(repoRoot, 'feat', repository.discoverTickets(), false),
    /missing dependency/,
  );
});

test('writes execution json when persisted', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-'));
  const issuesDir = path.join(repoRoot, '.scratch', 'feat', 'issues');
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(path.join(issuesDir, '01.md'), '---\nfeature: feat\nstatus: ready-for-agent\n---\n');
  const repository = new TicketRepository(repoRoot);
  buildFeatureExecutionGraph(repoRoot, 'feat', repository.discoverTickets());
  const execution = JSON.parse(readFileSync(path.join(repoRoot, '.scratch', 'feat', 'execution.json'), 'utf8')) as {
    feature: string;
    version: number;
  };
  assert.equal(execution.feature, 'feat');
  assert.equal(execution.version, 1);
});
