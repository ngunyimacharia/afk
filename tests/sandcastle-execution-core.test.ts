import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RuntimeStore } from '../src/runtime-store.js';
import { SandcastleImplementationCore } from '../src/sandcastle-execution-core.js';
import type { LaunchPlan, TicketRecord } from '../src/types.js';

const ticket: TicketRecord = {
  path: '/tmp/ticket.md',
  feature: 'feat',
  issueName: '001',
  label: 'feat/001',
  executorAfk: true,
};

function plan(repoRoot: string): LaunchPlan {
  return {
    repoRoot,
    harness: 'OpenCode',
    model: { id: 'opencode/model' },
    tickets: [ticket],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'feat',
      defaultWorktreeName: 'feat-001',
      effectiveWorktreeName: 'feat-001',
      defaultBranchName: 'afk/feat/001',
      effectiveBranchName: 'afk/feat/001',
      branchNameSource: 'fallback',
      worktreePath: path.join(repoRoot, '.worktree', 'feat-001'),
    },
  };
}

test('runs implementation through Sandcastle Docker sandbox and records result metadata', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-sandcastle-core-'));
  const store = new RuntimeStore({ repoRoot });
  const record = store.createRecord({ featureSlug: 'feat', issueName: '001', ticketPath: ticket.path });
  const providers: unknown[] = [];
  const createSandboxCalls: Array<{ cwd?: string; branch: string; sandbox: unknown }> = [];

  const core = new SandcastleImplementationCore(store, 'docker', {
    createDockerProvider: (() => ({ kind: 'docker-provider' })) as never,
    createNoSandboxProvider: (() => ({ kind: 'no-sandbox-provider' })) as never,
    createAgentProvider: (() => ({ name: 'opencode-agent' })) as never,
    createSandbox: (async (options: { cwd?: string; branch: string; sandbox: unknown }) => {
      createSandboxCalls.push(options as never);
      providers.push(options.sandbox);
      return {
        branch: options.branch,
        worktreePath: path.join(repoRoot, '.sandcastle', 'worktrees', 'feat-001'),
        run: async () => ({
          stdout: 'implementation output',
          commits: [{ sha: 'abc123' }],
          iterations: [],
          logFilePath: path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'feat-001.sandcastle.log'),
        }),
        close: async () => ({}),
      };
    }) as never,
  });

  const result = await core.execute({ plan: plan(repoRoot), ticket, prompt: 'do work', record });

  assert.equal(result.status, 'completed');
  assert.equal(createSandboxCalls[0]?.cwd, repoRoot);
  assert.equal(createSandboxCalls[0]?.branch, 'afk/feat/001');
  assert.deepEqual(providers[0], { kind: 'docker-provider' });
  const metadata = JSON.parse(readFileSync(record.metadataPath, 'utf8')) as Record<string, unknown>;
  assert.equal(metadata.SANDCASTLE_SANDBOX_MODE, 'docker');
  assert.equal(metadata.SANDCASTLE_BRANCH, 'afk/feat/001');
  assert.equal(metadata.SANDCASTLE_PROVIDER, 'opencode');
  assert.deepEqual(metadata.SANDCASTLE_COMMITS, ['abc123']);
  assert.deepEqual(metadata.SANDCASTLE_PHASE_RESULT, {
    phase: 'implementation',
    status: 'completed',
    stdout: 'implementation output',
  });
});

test('records Sandcastle failure detail when no-sandbox execution throws', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-sandcastle-fail-'));
  const store = new RuntimeStore({ repoRoot });
  const record = store.createRecord({ featureSlug: 'feat', issueName: '001', ticketPath: ticket.path });

  const core = new SandcastleImplementationCore(store, 'no-sandbox', {
    createDockerProvider: (() => ({ kind: 'docker-provider' })) as never,
    createNoSandboxProvider: (() => ({ kind: 'no-sandbox-provider' })) as never,
    createAgentProvider: (() => ({ name: 'opencode-agent' })) as never,
    createSandbox: (async (options: { branch: string }) => ({
      branch: options.branch,
      worktreePath: path.join(repoRoot, '.sandcastle', 'worktrees', 'feat-001'),
      run: async () => {
        throw new Error('agent exploded');
      },
      close: async () => ({}),
    })) as never,
  });

  const result = await core.execute({ plan: plan(repoRoot), ticket, prompt: 'do work', record });

  assert.equal(result.status, 'failed');
  assert.match(result.unsafeReason ?? '', /agent exploded/);
  const metadata = JSON.parse(readFileSync(record.metadataPath, 'utf8')) as Record<string, unknown>;
  assert.equal(metadata.SANDCASTLE_SANDBOX_MODE, 'no-sandbox');
  assert.equal(metadata.SANDCASTLE_WORKTREE_PATH, path.join(repoRoot, '.sandcastle', 'worktrees', 'feat-001'));
  assert.match(JSON.stringify(metadata.SANDCASTLE_PHASE_RESULT), /agent exploded/);
  assert.match(String(metadata.PROVIDER_FAILURE_EVIDENCE), /agent exploded/);
});
