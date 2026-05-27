import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type ActiveRunLifecycleState = 'starting' | 'running' | 'paused' | 'killing' | 'cleared';

export interface RunControlCommand {
  type: 'pause' | 'resume';
  issuedAt: string;
  clientPid: number;
}

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
  | { action: 'started'; record: ActiveRunRecord }
  | { action: 'attached'; record: ActiveRunRecord; reason: 'healthy-active-run' }
  | { action: 'recovered'; record: ActiveRunRecord; previousRecord: ActiveRunRecord; recoveryMessage: string };

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

    const nextRunId = existing ? existing.runId : runId;
    const nowIso = isoFromEpoch(this.now());
    const next: ActiveRunRecord = {
      version: 1,
      runId: nextRunId,
      pid: this.pid,
      startedAt: existing ? existing.startedAt : nowIso,
      heartbeatAt: nowIso,
      state: 'starting',
      command,
    };
    writeFileSync(this.activeRunPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

    if (existing) {
      this.clearCommands(existing.runId);
      const recoveryMessage = `Recovered stale run ${existing.runId} (previous PID ${existing.pid} dead, state was ${existing.state})`;
      return { action: 'recovered', record: next, previousRecord: existing, recoveryMessage };
    }

    return { action: 'started', record: next };
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
    this.clearCommands(runId);
  }

  private commandPath(runId: string): string {
    return path.join(path.dirname(this.activeRunPath), 'active-run-commands', `${runId}.jsonl`);
  }

  enqueueCommand(runId: string, command: Omit<RunControlCommand, 'issuedAt'>): void {
    const current = this.read();
    if (!current || current.runId !== runId) return;
    const commandPath = this.commandPath(runId);
    mkdirSync(path.dirname(commandPath), { recursive: true });
    const entry: RunControlCommand = { ...command, issuedAt: isoFromEpoch(this.now()) };
    appendFileSync(commandPath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  readCommands(runId: string, afterOffset: number): { commands: RunControlCommand[]; nextOffset: number } {
    const commandPath = this.commandPath(runId);
    if (!existsSync(commandPath)) return { commands: [], nextOffset: afterOffset };
    const raw = readFileSync(commandPath, 'utf8');
    const lines = raw.split('\n');
    const commands: RunControlCommand[] = [];
    let nextOffset = afterOffset;
    for (let i = afterOffset; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as Partial<RunControlCommand>;
        if (parsed && typeof parsed === 'object' && (parsed.type === 'pause' || parsed.type === 'resume')) {
          commands.push(parsed as RunControlCommand);
        }
      } catch {
        // skip malformed line
      }
      nextOffset = i + 1;
    }
    return { commands, nextOffset };
  }

  clearCommands(runId: string): void {
    const commandPath = this.commandPath(runId);
    rmSync(commandPath, { force: true });
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
