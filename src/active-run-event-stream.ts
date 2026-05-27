import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
    if (!existsSync(this.eventsPath)) return { events: [], nextOffset: offset };
    const content = readFileSync(this.eventsPath, 'utf8');
    const chunk = content.slice(Math.max(0, offset));
    if (!chunk) return { events: [], nextOffset: content.length };
    const lines = chunk.split('\n').filter((line) => line.trim().length > 0);
    const events: AgentExecutionProgressEvent[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as ActiveRunEventEnvelope;
        if (parsed.type === 'progress' && parsed.event) events.push(parsed.event);
      } catch {
        // ignore malformed lines from partial writes
      }
    }
    return { events, nextOffset: content.length };
  }

  readCommandsFromOffset(offset = 0): { commands: string[]; nextOffset: number } {
    if (!existsSync(this.eventsPath)) return { commands: [], nextOffset: offset };
    const content = readFileSync(this.eventsPath, 'utf8');
    const chunk = content.slice(Math.max(0, offset));
    if (!chunk) return { commands: [], nextOffset: content.length };
    const lines = chunk.split('\n').filter((line) => line.trim().length > 0);
    const commands: string[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as ActiveRunEventEnvelope;
        if (parsed.type === 'command' && parsed.command) commands.push(parsed.command);
      } catch {
        // ignore malformed lines from partial writes
      }
    }
    return { commands, nextOffset: content.length };
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
}
