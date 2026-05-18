import { createLogUpdate } from 'log-update';
import type { AgentExecutionProgressEvent } from './types.js';

export interface ProgressLine {
  update(event: AgentExecutionProgressEvent): void;
  done(): void;
}

export function createProgressLine(stdout: NodeJS.WriteStream): ProgressLine {
  if (!stdout.isTTY) return new NoopProgressLine();
  return new LogUpdateProgressLine(stdout);
}

class NoopProgressLine implements ProgressLine {
  update(_event: AgentExecutionProgressEvent): void {}
  done(): void {}
}

class LogUpdateProgressLine implements ProgressLine {
  private static readonly spinnerFrames = ['|', '/', '-', '\\'];
  private readonly logUpdate: ReturnType<typeof createLogUpdate>;
  private readonly latestByTicket = new Map<string, string>();
  private latestEvent: AgentExecutionProgressEvent | undefined;
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private hasRendered = false;

  constructor(private readonly stdout: NodeJS.WriteStream) {
    this.logUpdate = createLogUpdate(stdout, { showCursor: true });
  }

  update(event: AgentExecutionProgressEvent): void {
    this.latestByTicket.set(event.ticketLabel, event.message);
    this.latestEvent = event;
    this.startSpinner();
    this.render();
    this.hasRendered = true;
  }

  done(): void {
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    if (!this.hasRendered) return;
    this.logUpdate.done();
    this.stdout.write('\n');
  }

  private startSpinner(): void {
    if (this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % LogUpdateProgressLine.spinnerFrames.length;
      this.render();
    }, 120);
    this.spinnerTimer.unref?.();
  }

  private render(): void {
    if (!this.latestEvent) return;
    this.logUpdate(this.format(this.latestEvent));
  }

  private format(event: AgentExecutionProgressEvent): string {
    const active = this.latestByTicket.size;
    const spinner = LogUpdateProgressLine.spinnerFrames[this.spinnerFrame];
    const prefix = active > 1 ? `${spinner} ${active} active` : spinner;
    const session = event.sessionId && !event.message.includes(event.sessionId) ? ` [opencode: ${event.sessionId}]` : '';
    return `${prefix}: ${event.message}${session}`;
  }
}
