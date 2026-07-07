#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { SandcastleRuntimeRecord } from '../src/sandcastle-runtime-store.js';
import { SummaryReporter } from '../src/summary-reporter.js';

const REQUIRED_PROVIDERS = ['opencode', 'claude', 'codex', 'pi'] as const;
const REQUIRED_RUNTIME_IMAGE = 'afk-runtime:latest';
const SYNTHETIC_MODELS = new Set(['docker-e2e-smoke']);

function runtimeRunsRoot(repoRoot: string): string {
  return path.join(repoRoot, '.scratch', 'sandcastle-runtime', 'runs');
}

function readRuntimeRecords(repoRoot: string): SandcastleRuntimeRecord[] {
  const runsRoot = runtimeRunsRoot(repoRoot);
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
  if (record.sandbox.containerId) return record.sandbox.containerId;
  return undefined;
}

function dockerRuntimeImageAvailable(): boolean {
  const result = spawnSync('docker', ['image', 'inspect', REQUIRED_RUNTIME_IMAGE], { stdio: 'ignore' });
  return result.status === 0;
}

function nonEmptyFile(repoRoot: string, filePath: string | undefined): boolean {
  if (!filePath) return false;
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
  try {
    return statSync(resolved).isFile() && statSync(resolved).size > 0;
  } catch {
    return false;
  }
}

function realRunEvidenceProblems(repoRoot: string, record: SandcastleRuntimeRecord): string[] {
  const problems: string[] = [];
  if (record.trackerSource === 'manual') problems.push('manual tracker source');
  if (SYNTHETIC_MODELS.has(record.provider.model)) problems.push(`synthetic model ${record.provider.model}`);
  if (!nonEmptyFile(repoRoot, record.logs.run)) problems.push('missing non-empty run log');

  const completedPhases = new Set(
    record.phases.filter((phase) => phase.status === 'passed' && phase.completedAt).map((phase) => phase.phase),
  );
  for (const phaseName of ['implementation', 'review'] as const) {
    if (!completedPhases.has(phaseName)) problems.push(`missing completed ${phaseName} phase`);
  }
  if (!record.phases.some((phase) => nonEmptyFile(repoRoot, phase.logPath))) {
    problems.push('missing non-empty phase log');
  }
  if (record.commits.length === 0 && !record.phases.some((phase) => (phase.commits?.length ?? 0) > 0)) {
    problems.push('missing commit evidence');
  }
  return problems;
}

const repoRoot = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const recordsRoot = runtimeRunsRoot(repoRoot);
const records = readRuntimeRecords(repoRoot);
const summary = await new SummaryReporter({ repoRoot }).summarize();
const missing: string[] = [];

if (!existsSync(recordsRoot)) missing.push(`runtime records path ${path.relative(repoRoot, recordsRoot)}`);
const verified: Record<string, string> = {};

for (const provider of REQUIRED_PROVIDERS) {
  const candidates = records.filter(
    (candidate) =>
      candidate.provider.provider === provider &&
      candidate.sandbox.mode === 'docker' &&
      candidate.terminal.status === 'completed' &&
      containerIdentity(candidate),
  );
  if (candidates.length === 0) {
    missing.push(provider);
    continue;
  }

  const rejectedCandidates = candidates.map((candidate) => ({
    record: candidate,
    evidenceProblems: realRunEvidenceProblems(repoRoot, candidate),
  }));
  const accepted = rejectedCandidates.find(({ evidenceProblems }) => evidenceProblems.length === 0);
  if (!accepted) {
    const details = rejectedCandidates
      .map(({ record, evidenceProblems }) => `${record.runId}: ${evidenceProblems.join('; ')}`)
      .join(' | ');
    missing.push(`${provider}: ${details}`);
    continue;
  }

  const record = accepted.record;
  const container = containerIdentity(record);
  if (!container) {
    missing.push(`${provider}: missing container identity`);
    continue;
  }
  verified[provider] = `${record.runId} (${container})`;
  if (!summary.message.includes('sandbox: docker') || !summary.message.includes(container)) {
    missing.push(`${provider}: afk summary missing docker/container evidence`);
  }
}

if (!dockerRuntimeImageAvailable()) missing.unshift(`runtime image ${REQUIRED_RUNTIME_IMAGE}`);

if (missing.length) {
  console.error('Docker E2E acceptance evidence is incomplete.');
  console.error(`Missing: ${missing.join(', ')}`);
  console.error(
    `Run one completed Docker-isolated AFK ticket for each provider with ${REQUIRED_RUNTIME_IMAGE} present and rerun this verifier. Synthetic/manual smoke records are rejected.`,
  );
  process.exit(1);
}

console.log('Docker E2E acceptance evidence verified:');
for (const provider of REQUIRED_PROVIDERS) console.log(`- ${provider}: ${verified[provider]}`);
