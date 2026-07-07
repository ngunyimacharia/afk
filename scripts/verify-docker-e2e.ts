#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SummaryReporter } from '../src/summary-reporter.js';
import type { SandcastleRuntimeRecord } from '../src/sandcastle-runtime-store.js';

const REQUIRED_PROVIDERS = ['opencode', 'claude', 'codex', 'pi'] as const;

function readRuntimeRecords(repoRoot: string): SandcastleRuntimeRecord[] {
  const runsRoot = path.join(repoRoot, '.scratch', 'sandcastle-runtime', 'runs');
  try {
    return readdirSync(runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(runsRoot, entry.name, 'record.json'))
      .map((recordPath) => JSON.parse(readFileSync(recordPath, 'utf8')) as SandcastleRuntimeRecord);
  } catch {
    return [];
  }
}

function containerIdentity(record: SandcastleRuntimeRecord): string | undefined {
  if (record.sandbox.mode !== 'docker') return undefined;
  if (record.sandbox.containerName) return record.sandbox.containerName;
  return undefined;
}

const repoRoot = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const records = readRuntimeRecords(repoRoot);
const summary = await new SummaryReporter({ repoRoot }).summarize();
const missing: string[] = [];
const verified: Record<string, string> = {};

for (const provider of REQUIRED_PROVIDERS) {
  const record = records.find(
    (candidate) =>
      candidate.provider.provider === provider &&
      candidate.sandbox.mode === 'docker' &&
      candidate.terminal.status === 'completed' &&
      containerIdentity(candidate),
  );
  if (!record) {
    missing.push(provider);
    continue;
  }
  const container = containerIdentity(record)!;
  verified[provider] = `${record.runId} (${container})`;
  if (!summary.message.includes('sandbox: docker') || !summary.message.includes(container)) {
    missing.push(`${provider}: afk summary missing docker/container evidence`);
  }
}

if (missing.length) {
  console.error('Docker E2E acceptance evidence is incomplete.');
  console.error(`Missing: ${missing.join(', ')}`);
  console.error('Run one completed Docker-isolated ticket for each provider and rerun this verifier.');
  process.exit(1);
}

console.log('Docker E2E acceptance evidence verified:');
for (const provider of REQUIRED_PROVIDERS) console.log(`- ${provider}: ${verified[provider]}`);
