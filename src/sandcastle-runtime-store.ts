import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertPathWithinRoot } from './path-validation.js';
import type { SandcastleProviderFailure } from './sandcastle-provider.js';

export type SandcastleTrackerSource = 'scratch' | 'linear' | 'github' | 'manual';
export type SandcastleSandboxMode = 'docker' | 'none';
export type SandcastlePhaseName = 'implementation' | 'review' | 'fixup';
export type SandcastlePhaseStatus = 'running' | 'passed' | 'failed' | 'blocked' | 'skipped';
export type SandcastleTerminalStatus = 'completed' | 'handoff' | 'failed' | 'blocked' | 'interrupted';
export type SandcastleCleanupResourceType =
  | 'worktree'
  | 'branch'
  | 'docker-container'
  | 'docker-volume'
  | 'log'
  | 'other';

export interface SandcastleRuntimeStoreInput {
  repoRoot: string;
  now?: () => number;
}

export interface SandcastleTicketIdentity {
  featureSlug: string;
  issueName: string;
  label: string;
  ticketPath: string;
  trackerIssueId?: string;
  trackerIssueKey?: string;
  trackerIssueUrl?: string;
}

export interface SandcastleProviderIdentity {
  provider: string;
  model: string;
  reviewerProvider?: string;
  reviewerModel?: string;
}

export type SandcastleSandbox =
  | {
      mode: 'docker';
      image?: string;
      containerName?: string;
    }
  | {
      mode: 'none';
    };

export interface SandcastleRunLocation {
  branch: string;
  worktreePath: string;
}

export interface SandcastleLogPaths {
  run: string;
  phases: string[];
}

export interface SandcastleRuntimeCreateInput {
  runId: string;
  ticket: SandcastleTicketIdentity;
  trackerSource: SandcastleTrackerSource;
  provider: SandcastleProviderIdentity;
  sandbox: SandcastleSandbox;
  location: SandcastleRunLocation;
  logs?: Partial<SandcastleLogPaths>;
}

export interface SandcastleRuntimeHandle {
  runId: string;
  recordPath: string;
  runDirectory: string;
}

export interface SandcastleCommitRecord {
  sha: string;
  subject?: string;
}

export interface SandcastlePhaseAttempt {
  phase: SandcastlePhaseName;
  attempt: number;
  status: SandcastlePhaseStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  outcome?: string;
  commits?: SandcastleCommitRecord[];
  logPath?: string;
}

export interface SandcastlePhaseUpdateInput {
  phase: SandcastlePhaseName;
  attempt?: number;
  status: SandcastlePhaseStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  outcome?: string;
  commits?: SandcastleCommitRecord[];
  logPath?: string;
}

export interface SandcastleTerminalUpdateInput {
  status: SandcastleTerminalStatus;
  handoffReason?: string;
  completedAt?: string;
}

export interface SandcastleCleanupResource {
  type: SandcastleCleanupResourceType;
  id: string;
  path?: string;
  cleanupCommand?: string;
}

export interface SandcastleProviderFailureRecord extends SandcastleProviderFailure {
  phase?: SandcastlePhaseName;
  occurredAt: string;
}

export interface SandcastleRuntimeRecord {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  updatedAt: string;
  ticket: SandcastleTicketIdentity;
  trackerSource: SandcastleTrackerSource;
  provider: SandcastleProviderIdentity;
  sandbox: SandcastleSandbox;
  branch: string;
  worktreePath: string;
  phases: SandcastlePhaseAttempt[];
  commits: SandcastleCommitRecord[];
  logs: SandcastleLogPaths;
  terminal: {
    status: 'running' | SandcastleTerminalStatus;
    completedAt?: string;
    handoffReason?: string;
  };
  providerFailures: SandcastleProviderFailureRecord[];
  cleanupResources: SandcastleCleanupResource[];
}

function isoFromEpoch(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function uniqueCommits(commits: SandcastleCommitRecord[]): SandcastleCommitRecord[] {
  const seen = new Set<string>();
  const unique: SandcastleCommitRecord[] = [];
  for (const commit of commits) {
    if (seen.has(commit.sha)) continue;
    seen.add(commit.sha);
    unique.push(commit);
  }
  return unique;
}

export class SandcastleRuntimeStore {
  private readonly runtimeRoot: string;
  private readonly runtimeRootResolved: string;
  private readonly now: () => number;

  constructor(input: SandcastleRuntimeStoreInput) {
    this.runtimeRoot = path.join(input.repoRoot, '.scratch', 'sandcastle-runtime');
    this.runtimeRootResolved = path.resolve(this.runtimeRoot);
    this.now = input.now ?? Date.now;
  }

  createRun(input: SandcastleRuntimeCreateInput): SandcastleRuntimeHandle {
    const runDirectory = path.join(this.runtimeRoot, 'runs', input.runId);
    const recordPath = path.join(runDirectory, 'record.json');
    this.assertManagedPath(recordPath, 'Sandcastle runtime record');
    mkdirSync(runDirectory, { recursive: true });

    const createdAt = isoFromEpoch(this.now());
    const record: SandcastleRuntimeRecord = {
      schemaVersion: 1,
      runId: input.runId,
      createdAt,
      updatedAt: createdAt,
      ticket: input.ticket,
      trackerSource: input.trackerSource,
      provider: input.provider,
      sandbox: input.sandbox,
      branch: input.location.branch,
      worktreePath: input.location.worktreePath,
      phases: [],
      commits: [],
      logs: {
        run: input.logs?.run ?? path.join(runDirectory, 'run.log'),
        phases: input.logs?.phases ?? [],
      },
      terminal: { status: 'running' },
      providerFailures: [],
      cleanupResources: [],
    };
    this.writeRecord(recordPath, record);
    return { runId: input.runId, recordPath, runDirectory };
  }

  readRun(recordPath: string): SandcastleRuntimeRecord {
    this.assertManagedPath(recordPath, 'Sandcastle runtime record');
    return JSON.parse(readFileSync(recordPath, 'utf8')) as SandcastleRuntimeRecord;
  }

  recordPhase(recordPath: string, input: SandcastlePhaseUpdateInput): SandcastleRuntimeRecord {
    const current = this.readRun(recordPath);
    const updatedAt = isoFromEpoch(this.now());
    const attempt = input.attempt ?? current.phases.filter((phase) => phase.phase === input.phase).length + 1;
    const phase: SandcastlePhaseAttempt = {
      phase: input.phase,
      attempt,
      status: input.status,
      startedAt: input.startedAt ?? updatedAt,
      completedAt: input.completedAt,
      durationMs: input.durationMs,
      outcome: input.outcome,
      commits: input.commits,
      logPath: input.logPath,
    };
    const phases = current.phases.filter((existing) => existing.phase !== input.phase || existing.attempt !== attempt);
    phases.push(phase);
    const logs = input.logPath ? { ...current.logs, phases: [...current.logs.phases, input.logPath] } : current.logs;
    return this.writeRecordAndReturn(recordPath, {
      ...current,
      updatedAt,
      phases,
      commits: uniqueCommits([...current.commits, ...(input.commits ?? [])]),
      logs,
    });
  }

  updateTerminal(recordPath: string, input: SandcastleTerminalUpdateInput): SandcastleRuntimeRecord {
    const current = this.readRun(recordPath);
    const updatedAt = isoFromEpoch(this.now());
    return this.writeRecordAndReturn(recordPath, {
      ...current,
      updatedAt,
      terminal: {
        status: input.status,
        completedAt: input.completedAt ?? updatedAt,
        handoffReason: input.handoffReason,
      },
    });
  }

  recordCleanupResource(recordPath: string, resource: SandcastleCleanupResource): SandcastleRuntimeRecord {
    const current = this.readRun(recordPath);
    return this.writeRecordAndReturn(recordPath, {
      ...current,
      updatedAt: isoFromEpoch(this.now()),
      cleanupResources: [...current.cleanupResources, resource],
    });
  }

  recordProviderFailure(
    recordPath: string,
    failure: SandcastleProviderFailure,
    phase?: SandcastlePhaseName,
  ): SandcastleRuntimeRecord {
    const current = this.readRun(recordPath);
    const updatedAt = isoFromEpoch(this.now());
    return this.writeRecordAndReturn(recordPath, {
      ...current,
      updatedAt,
      providerFailures: [...current.providerFailures, { ...failure, phase, occurredAt: updatedAt }],
    });
  }

  private writeRecord(recordPath: string, record: SandcastleRuntimeRecord): void {
    this.assertManagedPath(recordPath, 'Sandcastle runtime record');
    mkdirSync(path.dirname(recordPath), { recursive: true });
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  private writeRecordAndReturn(recordPath: string, record: SandcastleRuntimeRecord): SandcastleRuntimeRecord {
    this.writeRecord(recordPath, record);
    return record;
  }

  private assertManagedPath(targetPath: string, label: string): void {
    assertPathWithinRoot(targetPath, this.runtimeRootResolved, label);
  }
}
