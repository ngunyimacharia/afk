import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { type SandcastleRuntimeCreateInput, SandcastleRuntimeStore } from '../src/sandcastle-runtime-store.js';

function createInput(overrides: Partial<SandcastleRuntimeCreateInput> = {}): SandcastleRuntimeCreateInput {
  return {
    runId: 'run-1',
    ticket: {
      featureSlug: 'feature-a',
      issueName: '001',
      label: 'feature-a/001',
      ticketPath: '/tmp/001.md',
    },
    trackerSource: 'scratch',
    provider: {
      provider: 'opencode',
      model: 'openai/gpt-5.5',
      reviewerProvider: 'claude',
      reviewerModel: 'sonnet',
    },
    sandbox: { mode: 'docker', image: 'afk-runtime:latest', containerName: 'afk-run-1' },
    location: {
      branch: 'afk/feature-a/001',
      worktreePath: '/tmp/worktree',
    },
    ...overrides,
  };
}

test('creates a Sandcastle runtime record in the new runtime directory', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-sandcastle-runtime-'));
  const store = new SandcastleRuntimeStore({ repoRoot, now: () => 0 });

  const handle = store.createRun(createInput());

  assert.equal(
    handle.recordPath,
    path.join(repoRoot, '.scratch', 'sandcastle-runtime', 'runs', 'run-1', 'record.json'),
  );
  const record = JSON.parse(readFileSync(handle.recordPath, 'utf8'));
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.ticket.label, 'feature-a/001');
  assert.equal(record.trackerSource, 'scratch');
  assert.deepEqual(record.provider, {
    provider: 'opencode',
    model: 'openai/gpt-5.5',
    reviewerProvider: 'claude',
    reviewerModel: 'sonnet',
  });
  assert.equal(record.sandbox.mode, 'docker');
  assert.equal(record.branch, 'afk/feature-a/001');
  assert.equal(record.worktreePath, '/tmp/worktree');
  assert.equal(record.terminal.status, 'running');
  assert.deepEqual(record.phases, []);
  assert.deepEqual(record.cleanupResources, []);
});

test('represents no-sandbox runs', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-sandcastle-runtime-none-'));
  const store = new SandcastleRuntimeStore({ repoRoot });

  const handle = store.createRun(createInput({ runId: 'run-none', sandbox: { mode: 'none' } }));

  const record = store.readRun(handle.recordPath);
  assert.deepEqual(record.sandbox, { mode: 'none' });
});

test('records implementation, review, and fixup phase attempts', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-sandcastle-runtime-phases-'));
  let tick = 0;
  const store = new SandcastleRuntimeStore({ repoRoot, now: () => tick++ * 1000 });
  const handle = store.createRun(createInput());

  store.recordPhase(handle.recordPath, {
    phase: 'implementation',
    status: 'passed',
    outcome: 'implemented ticket',
    commits: [{ sha: 'abc123', subject: 'feat: add schema' }],
    logPath: '/tmp/implementation.log',
  });
  store.recordPhase(handle.recordPath, {
    phase: 'review',
    status: 'failed',
    attempt: 1,
    outcome: 'review requested fixes',
  });
  const record = store.recordPhase(handle.recordPath, {
    phase: 'fixup',
    status: 'passed',
    attempt: 1,
    outcome: 'fixed review findings',
  });

  assert.deepEqual(
    record.phases.map((phase) => phase.phase),
    ['implementation', 'review', 'fixup'],
  );
  assert.equal(record.phases[0]?.attempt, 1);
  assert.equal(record.phases[0]?.status, 'passed');
  assert.deepEqual(record.commits, [{ sha: 'abc123', subject: 'feat: add schema' }]);
  assert.deepEqual(record.logs.phases, ['/tmp/implementation.log']);
});

test('updates terminal status and handoff reason', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-sandcastle-runtime-terminal-'));
  const store = new SandcastleRuntimeStore({ repoRoot, now: () => 0 });
  const handle = store.createRun(createInput());

  const record = store.updateTerminal(handle.recordPath, {
    status: 'handoff',
    handoffReason: 'review needs human judgement',
  });

  assert.equal(record.terminal.status, 'handoff');
  assert.equal(record.terminal.handoffReason, 'review needs human judgement');
  assert.equal(record.terminal.completedAt, '1970-01-01T00:00:00.000Z');
});

test('records cleanup resources', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-sandcastle-runtime-cleanup-'));
  const store = new SandcastleRuntimeStore({ repoRoot });
  const handle = store.createRun(createInput());

  const record = store.recordCleanupResource(handle.recordPath, {
    type: 'docker-container',
    id: 'afk-run-1',
    cleanupCommand: 'docker rm -f afk-run-1',
  });

  assert.deepEqual(record.cleanupResources, [
    {
      type: 'docker-container',
      id: 'afk-run-1',
      cleanupCommand: 'docker rm -f afk-run-1',
    },
  ]);
});

test('does not read or migrate old opencode runtime artifacts', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-sandcastle-runtime-legacy-'));
  const legacyRoot = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata');
  mkdirSync(legacyRoot, { recursive: true });
  writeFileSync(path.join(legacyRoot, 'feature-a-001.json'), 'not json', 'utf8');
  const store = new SandcastleRuntimeStore({ repoRoot });

  const handle = store.createRun(createInput());

  assert.equal(handle.recordPath.includes('.opencode-afk-logs'), false);
  assert.equal(readFileSync(path.join(legacyRoot, 'feature-a-001.json'), 'utf8'), 'not json');
});
