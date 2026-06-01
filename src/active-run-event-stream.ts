import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AgentExecutionProgressEvent } from './types.js';

interface ActiveRunEventEnvelope {
  type: 'progress' | 'run-state' | 'command';
  event?: AgentExecutionProgressEvent;
  state?: string;
  command?: string;
}

export class ActiveRunEventStream {
  private readonly eventsPath: string;

  constructor(repoRoot: string, runId: string) {
    this.eventsPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'active-run-events', `${runId}.jsonl`);
  }

  appendProgress(event: AgentExecutionProgressEvent): void {
    this.append({ type: 'progress', event });
  }

  appendRunState(state: string): void {
    this.append({ type: 'run-state', state });
  }

  appendCommand(command: string): void {
    this.append({ type: 'command', command });
  }

  readFromOffset(offset = 0): { events: AgentExecutionProgressEvent[]; nextOffset: number } {
    const { envelopes, nextOffset } = this.readEnvelopesFromOffset(offset);
    const events: AgentExecutionProgressEvent[] = [];
    for (const parsed of envelopes) {
      if (parsed.type === 'progress' && parsed.event) events.push(parsed.event);
    }
    return { events, nextOffset };
  }

  readCommandsFromOffset(offset = 0): { commands: string[]; nextOffset: number } {
    const { envelopes, nextOffset } = this.readEnvelopesFromOffset(offset);
    const commands: string[] = [];
    for (const parsed of envelopes) {
      if (parsed.type === 'command' && parsed.command) commands.push(parsed.command);
    }
    return { commands, nextOffset };
  }

  readAllEvents(): AgentExecutionProgressEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    const content = readFileSync(this.eventsPath, 'utf8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    const events: AgentExecutionProgressEvent[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as ActiveRunEventEnvelope;
        if (parsed.type === 'progress' && parsed.event) events.push(parsed.event);
      } catch {
        // ignore malformed lines from partial writes
      }
    }
    return events;
  }

  private append(envelope: ActiveRunEventEnvelope): void {
    mkdirSync(path.dirname(this.eventsPath), { recursive: true });
    appendFileSync(this.eventsPath, `${JSON.stringify(envelope)}\n`, 'utf8');
  }

  private readEnvelopesFromOffset(offset = 0): { envelopes: ActiveRunEventEnvelope[]; nextOffset: number } {
    if (!existsSync(this.eventsPath)) return { envelopes: [], nextOffset: offset };
    const size = statSync(this.eventsPath).size;
    const start = Math.max(0, Math.min(offset, size));
    if (start === size) return { envelopes: [], nextOffset: size };

    const fd = openSync(this.eventsPath, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
      const chunk = buffer.subarray(0, bytesRead).toString('utf8');
      if (!chunk) return { envelopes: [], nextOffset: start };

      const lines = chunk.split('\n');
      let nextOffset = start + Buffer.byteLength(chunk, 'utf8');
      if (!chunk.endsWith('\n')) {
        const partial = lines.pop() ?? '';
        nextOffset -= Buffer.byteLength(partial, 'utf8');
      }

      const envelopes: ActiveRunEventEnvelope[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          envelopes.push(JSON.parse(trimmed) as ActiveRunEventEnvelope);
        } catch {
          // ignore malformed lines from partial writes
        }
      }
      return { envelopes, nextOffset };
    } finally {
      closeSync(fd);
    }
  }
}
