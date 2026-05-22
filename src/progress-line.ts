import { createLogUpdate } from 'log-update';
import type { AgentExecutionProgressEvent } from './types.js';

export interface ProgressLine {
  update(event: AgentExecutionProgressEvent): void;
  done(): void;
}

export interface ProgressLineOptions {
  isPromptActive?: () => boolean;
  providerName?: string;
}

export function createProgressLine(stdout: NodeJS.WriteStream, options: ProgressLineOptions = {}): ProgressLine {
  if (!stdout.isTTY) return new NoopProgressLine();
  return new LogUpdateProgressLine(stdout, options.isPromptActive ?? (() => false), options.providerName);
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
  private activePermissionKey: string | undefined;
  private readonly providerName: string;

  constructor(
    private readonly stdout: NodeJS.WriteStream,
    private readonly isPromptActive: () => boolean,
    providerName?: string,
  ) {
    this.logUpdate = createLogUpdate(stdout, { showCursor: true });
    this.providerName = providerName || 'opencode';
  }

  update(event: AgentExecutionProgressEvent): void {
    if (event.kind === 'permission') {
      this.renderPermission(event);
      return;
    }
    if (event.kind === 'failure') {
      this.renderFailure(event);
      return;
    }
    if (this.isPromptActive()) {
      this.latestByTicket.set(event.ticketLabel, event.message);
      this.latestEvent = event;
      this.stopSpinner();
      return;
    }
    if (this.activePermissionKey && event.message === 'opencode session busy') return;
    this.activePermissionKey = undefined;
    this.latestByTicket.set(event.ticketLabel, event.message);
    this.latestEvent = event;
    this.startSpinner();
    this.render();
    this.hasRendered = true;
  }

  done(): void {
    this.stopSpinner();
    if (!this.hasRendered) return;
    this.logUpdate.done();
    this.stdout.write('\n');
  }

  private startSpinner(): void {
    if (this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      if (this.isPromptActive()) {
        this.stopSpinner();
        return;
      }
      this.spinnerFrame = (this.spinnerFrame + 1) % LogUpdateProgressLine.spinnerFrames.length;
      this.render();
    }, 120);
    this.spinnerTimer.unref?.();
  }

  private stopSpinner(): void {
    if (!this.spinnerTimer) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }

  private render(): void {
    if (!this.latestEvent) return;
    this.logUpdate(this.format(this.latestEvent));
  }

  private format(event: AgentExecutionProgressEvent): string {
    const active = this.latestByTicket.size;
    const spinner = LogUpdateProgressLine.spinnerFrames[this.spinnerFrame];
    const prefix = active > 1 ? `${spinner} ${active} active` : spinner;
    const session =
      event.sessionId && !event.message.includes(event.sessionId) ? ` [${this.providerName}: ${event.sessionId}]` : '';
    return `${prefix}: ${event.message}${session}`;
  }

  private renderPermission(event: AgentExecutionProgressEvent): void {
    const key = `${event.ticketLabel}:${event.permissionId ?? event.message}`;
    if (this.activePermissionKey === key) return;
    this.activePermissionKey = key;
    this.stopSpinner();
    if (this.hasRendered) this.logUpdate.done();
    const session =
      event.sessionId && !event.message.includes(event.sessionId) ? ` [${this.providerName}: ${event.sessionId}]` : '';
    this.stdout.write(`Permission required for ${event.ticketLabel}: ${event.message}${session}\n`);
    this.hasRendered = false;
  }

  private renderFailure(event: AgentExecutionProgressEvent): void {
    this.stopSpinner();
    if (this.hasRendered) this.logUpdate.done();
    const session =
      event.sessionId && !event.message.includes(event.sessionId) ? ` [${this.providerName}: ${event.sessionId}]` : '';
    this.stdout.write(`Provider failure for ${event.ticketLabel}: ${event.message}${session}\n`);
    this.hasRendered = false;
  }
}
