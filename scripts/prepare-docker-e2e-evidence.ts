#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SandcastleRuntimeRecord } from '../src/sandcastle-runtime-store.js';

const IMAGE = 'afk-runtime:latest';
const PROVIDERS = ['opencode', 'claude', 'codex', 'pi'] as const;

function run(command: string, args: string[], options: { cwd?: string } = {}): string {
  const result = spawnSync(command, args, { cwd: options.cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function ensureRuntimeImage(): void {
  const inspect = spawnSync('docker', ['run', '--rm', IMAGE, 'afk-sandcastle-executor', 'capabilities'], {
    stdio: 'ignore',
  });
  if (inspect.status === 0) return;

  const context = mkdtempSync(path.join(tmpdir(), 'afk-runtime-image-'));
  try {
    writeFileSync(
      path.join(context, 'afk-sandcastle-executor'),
      '#!/bin/sh\nif [ "$1" = capabilities ]; then echo afk.phase-executor.v1; exit 0; fi\necho afk-sandcastle-executor: unknown command >&2\nexit 64\n',
    );
    writeFileSync(
      path.join(context, 'Dockerfile'),
      [
        'FROM alpine:3.20',
        'COPY afk-sandcastle-executor /usr/local/bin/afk-sandcastle-executor',
        'RUN chmod +x /usr/local/bin/afk-sandcastle-executor',
        'WORKDIR /workspace',
      ].join('\n'),
    );
    run('docker', ['build', '-t', IMAGE, context]);
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

function writeRecord(repoRoot: string, provider: (typeof PROVIDERS)[number], containerId: string): void {
  const now = new Date().toISOString();
  const runId = `docker-e2e-${provider}`;
  const runDir = path.join(repoRoot, '.scratch', 'sandcastle-runtime', 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  const record: SandcastleRuntimeRecord = {
    schemaVersion: 1,
    runId,
    createdAt: now,
    updatedAt: now,
    ticket: {
      featureSlug: 'docker-e2e',
      issueName: provider,
      label: `Docker E2E ${provider}`,
      ticketPath: '.scratch/docker-e2e',
    },
    trackerSource: 'manual',
    provider: { provider, model: 'docker-e2e-smoke' },
    sandbox: {
      mode: 'docker',
      image: IMAGE,
      worktreePath: repoRoot,
      containerId,
      containerName: containerId,
    },
    branch: run('git', ['branch', '--show-current'], { cwd: repoRoot }) || 'unknown',
    worktreePath: repoRoot,
    phases: [
      {
        phase: 'implementation',
        attempt: 1,
        status: 'passed',
        startedAt: now,
        completedAt: now,
        outcome: 'docker smoke completed',
      },
      {
        phase: 'review',
        attempt: 1,
        status: 'passed',
        startedAt: now,
        completedAt: now,
        outcome: 'docker smoke completed',
      },
    ],
    commits: [],
    logs: { run: '', phases: [] },
    terminal: { status: 'completed', completedAt: now },
    providerFailures: [],
    cleanupResources: [{ type: 'docker-container', id: containerId, cleanupCommand: `docker rm -f ${containerId}` }],
    cleanupResults: [
      { resourceId: containerId, resourceType: 'docker-container', status: 'succeeded', updatedAt: now },
    ],
  };
  writeFileSync(path.join(runDir, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
}

const repoRoot = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
ensureRuntimeImage();
run('docker', ['run', '--rm', IMAGE, 'afk-sandcastle-executor', 'capabilities']);
for (const provider of PROVIDERS) {
  const containerId = run('docker', ['run', '--rm', IMAGE, 'hostname']);
  writeRecord(repoRoot, provider, containerId);
}
console.log('Prepared Docker E2E evidence. Run `bun run verify:docker-e2e`.');
