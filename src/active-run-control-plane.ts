import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type ActiveRunLifecycleState = 'starting' | 'running' | 'paused' | 'killing' | 'cleared';

export interface ActiveRunRecord {
  version: 1;
  runId: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  state: ActiveRunLifecycleState;
  command: string;
}

export interface ActiveRunControlPlaneInput {
  repoRoot: string;
  now?: () => number;
  pid?: number;
  staleHeartbeatMs?: number;
}

export type ActiveRunAcquireResult =
  | { action: 'started'; record: ActiveRunRecord; staleReclaimed: boolean }
  | { action: 'attached'; record: ActiveRunRecord; reason: 'healthy-active-run' };

function isoFromEpoch(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export class ActiveRunControlPlane {
  private readonly activeRunPath: string;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly staleHeartbeatMs: number;

  constructor(input: ActiveRunControlPlaneInput) {
    this.activeRunPath = path.join(input.repoRoot, '.scratch', '.opencode-afk-logs', 'active-run.json');
    this.now = input.now ?? Date.now;
    this.pid = input.pid ?? process.pid;
    this.staleHeartbeatMs = input.staleHeartbeatMs ?? 90_000;
  }

  acquireOrAttach(runId: string, command = 'afk'): ActiveRunAcquireResult {
    mkdirSync(path.dirname(this.activeRunPath), { recursive: true });
    const existing = this.read();
    if (existing && this.isHealthy(existing)) return { action: 'attached', record: existing, reason: 'healthy-active-run' };

    const nowIso = isoFromEpoch(this.now());
    const next: ActiveRunRecord = {
      version: 1,
      runId,
      pid: this.pid,
      startedAt: nowIso,
      heartbeatAt: nowIso,
      state: 'starting',
      command,
    };
    writeFileSync(this.activeRunPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return { action: 'started', record: next, staleReclaimed: Boolean(existing) };
  }

  transition(runId: string, state: ActiveRunLifecycleState): void {
    const current = this.read();
    if (!current || current.runId !== runId) return;
    const next: ActiveRunRecord = { ...current, state, heartbeatAt: isoFromEpoch(this.now()) };
    writeFileSync(this.activeRunPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  }

  heartbeat(runId: string): void {
    const current = this.read();
    if (!current || current.runId !== runId) return;
    const next: ActiveRunRecord = { ...current, heartbeatAt: isoFromEpoch(this.now()) };
    writeFileSync(this.activeRunPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  }

  clear(runId: string): void {
    const current = this.read();
    if (!current || current.runId !== runId) return;
    const cleared: ActiveRunRecord = { ...current, state: 'cleared', heartbeatAt: isoFromEpoch(this.now()) };
    writeFileSync(this.activeRunPath, `${JSON.stringify(cleared, null, 2)}\n`, 'utf8');
    rmSync(this.activeRunPath, { force: true });
  }

  read(): ActiveRunRecord | null {
    if (!existsSync(this.activeRunPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.activeRunPath, 'utf8')) as Partial<ActiveRunRecord>;
      if (!parsed || typeof parsed !== 'object') return null;
      if (parsed.version !== 1) return null;
      if (typeof parsed.runId !== 'string') return null;
      if (typeof parsed.pid !== 'number') return null;
      if (typeof parsed.startedAt !== 'string') return null;
      if (typeof parsed.heartbeatAt !== 'string') return null;
      if (typeof parsed.state !== 'string') return null;
      if (typeof parsed.command !== 'string') return null;
      return parsed as ActiveRunRecord;
    } catch {
      return null;
    }
  }

  private isHealthy(record: ActiveRunRecord): boolean {
    if (!this.isPidAlive(record.pid)) return false;
    const heartbeatEpoch = Date.parse(record.heartbeatAt);
    if (!Number.isFinite(heartbeatEpoch)) return false;
    return this.now() - heartbeatEpoch <= this.staleHeartbeatMs;
  }

  private isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
