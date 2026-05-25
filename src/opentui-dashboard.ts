import type { BoxRenderable, CliRenderer, TextRenderable } from '@opentui/core';
import type { LiveRunView } from './live-run-view.js';
import type { ProgressLine, ProgressLineOptions } from './progress-line.js';
import { createProgressLine } from './progress-line.js';
import { type DashboardSnapshot, RunDashboardState, type RunDashboardStateOptions } from './run-dashboard-state.js';
import type { AgentExecutionProgressEvent, TicketRecord } from './types.js';

export interface OpenTuiDashboardOptions {
  stdout: NodeJS.WriteStream;
  selectedTickets?: TicketRecord[];
  runOptions?: RunDashboardStateOptions;
}

export interface OpenTuiDashboardModule {
  createCliRenderer(config?: {
    stdout?: NodeJS.WriteStream;
    screenMode?: string;
    clearOnShutdown?: boolean;
    exitOnCtrlC?: boolean;
    testing?: boolean;
  }): Promise<CliRenderer>;
  BoxRenderable: new (
    ctx: CliRenderer,
    options: {
      flexDirection?: string;
      width?: number | string;
      height?: number | string;
      flexGrow?: number;
      gap?: number;
      border?: boolean;
      title?: string;
      titleAlignment?: string;
    },
  ) => BoxRenderable;
  TextRenderable: new (
    ctx: CliRenderer,
    options: {
      content?: string;
    },
  ) => TextRenderable;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  return `${seconds}s`;
}

function formatHeader(snap: DashboardSnapshot): string {
  const elapsed = formatElapsed(snap.elapsedMs);
  const parts: string[] = [];
  if (snap.runId) parts.push(`Run: ${snap.runId}`);
  if (snap.modelId) parts.push(`Model: ${snap.modelId}`);
  if (snap.harness) parts.push(`Harness: ${snap.harness}`);
  if (snap.concurrency) parts.push(`Concurrency: ${snap.concurrency}`);
  parts.push(`Elapsed: ${elapsed}`);
  return parts.join(' | ');
}

function formatAggregate(snap: DashboardSnapshot): string {
  return `Ready: ${snap.aggregate.ready} | Running: ${snap.aggregate.running} | Blocked: ${snap.aggregate.blocked} | Failed: ${snap.aggregate.failed} | Complete: ${snap.aggregate.complete}`;
}

function formatFeatures(snap: DashboardSnapshot): string {
  if (snap.features.length === 0) return 'No features';
  return snap.features
    .map((f) => {
      const state = f.aggregateState.toUpperCase();
      const count = f.tickets.length;
      return `${f.feature} [${state}] (${count} ticket${count === 1 ? '' : 's'})`;
    })
    .join('\n');
}

function formatTickets(snap: DashboardSnapshot): string {
  if (snap.tickets.length === 0) return 'No tickets';
  return snap.tickets
    .map((t) => {
      const state = t.runtimeState.toUpperCase();
      const msg = t.latestMessage ? ` - ${t.latestMessage.slice(0, 40)}` : '';
      const selected = snap.selectedTicket?.label === t.label ? '>' : ' ';
      return `${selected} ${t.label} [${state}]${msg}`;
    })
    .join('\n');
}

function formatActionNeeded(snap: DashboardSnapshot): string {
  if (snap.actionNeeded.length === 0) return 'No action needed';
  return snap.actionNeeded.map((a) => `[${a.kind}] ${a.ticketLabel}: ${a.message.slice(0, 60)}`).join('\n');
}

function formatEvents(snap: DashboardSnapshot): string {
  if (snap.recentEvents.length === 0) return 'No events yet';
  return snap.recentEvents
    .slice(-10)
    .map((e) => `${e.ticketLabel}: ${e.message.slice(0, 80)}`)
    .join('\n');
}

function formatDetails(snap: DashboardSnapshot): string {
  const details = snap.selectedTicketDetails;
  if (!details) {
    if (snap.tickets.length === 0) return 'No tickets in run';
    return 'Select a ticket to view details';
  }

  const lines: string[] = [];
  lines.push(`${details.label} [${details.runtimeState.toUpperCase()}]`);
  lines.push(`Path: ${details.path}`);
  if (details.status) lines.push(`Status: ${details.status}`);
  if (details.sessionId) lines.push(`Session: ${details.sessionId}`);
  if (details.dependencies.length > 0) lines.push(`Deps: ${details.dependencies.join(', ')}`);
  if (details.failureKind) lines.push(`Failure: ${details.failureKind}`);
  if (details.reviewOutcome) {
    const review = details.reviewReason ? `${details.reviewOutcome} (${details.reviewReason})` : details.reviewOutcome;
    lines.push(`Review: ${review}`);
  }
  if (details.actionNeededCount > 0) lines.push(`Action needed: ${details.actionNeededCount}`);

  if (details.phaseHistory.length > 0) {
    lines.push('Phases:');
    for (const phase of details.phaseHistory.slice(-5)) {
      lines.push(`  ${phase.name} ${phase.durationMs}ms`);
    }
  }

  if (details.recentEvents.length > 0) {
    lines.push('Recent events:');
    for (const event of details.recentEvents.slice(-5)) {
      lines.push(`  ${event.message.slice(0, 60)}`);
    }
  }

  return lines.join('\n');
}

class OpenTuiDashboard implements LiveRunView {
  private destroyed = false;
  private readonly state: RunDashboardState;
  private headerText!: TextRenderable;
  private featuresText!: TextRenderable;
  private ticketsText!: TextRenderable;
  private actionText!: TextRenderable;
  private eventsText!: TextRenderable;
  private detailsText!: TextRenderable;

  constructor(
    private readonly renderer: CliRenderer,
    selectedTickets: TicketRecord[],
    runOptions: RunDashboardStateOptions,
    private readonly opentui: OpenTuiDashboardModule,
  ) {
    this.state = new RunDashboardState(runOptions, selectedTickets);
    this.buildLayout();
    this.registerInputHandler();
    this.refresh();
  }

  private buildLayout(): void {
    const root = new this.opentui.BoxRenderable(this.renderer, {
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      gap: 1,
    });

    const headerBox = new this.opentui.BoxRenderable(this.renderer, {
      border: true,
      title: 'AFK Run Dashboard',
      titleAlignment: 'center',
      flexDirection: 'column',
    });
    this.headerText = new this.opentui.TextRenderable(this.renderer, { content: '' });
    headerBox.add(this.headerText);
    root.add(headerBox);

    const contentBox = new this.opentui.BoxRenderable(this.renderer, {
      flexDirection: 'row',
      flexGrow: 1,
      gap: 1,
    });

    const featuresBox = new this.opentui.BoxRenderable(this.renderer, {
      border: true,
      title: 'Features',
      width: '15%',
      flexDirection: 'column',
    });
    this.featuresText = new this.opentui.TextRenderable(this.renderer, { content: '' });
    featuresBox.add(this.featuresText);
    contentBox.add(featuresBox);

    const ticketsBox = new this.opentui.BoxRenderable(this.renderer, {
      border: true,
      title: 'Tickets',
      width: '35%',
      flexDirection: 'column',
    });
    this.ticketsText = new this.opentui.TextRenderable(this.renderer, { content: '' });
    ticketsBox.add(this.ticketsText);
    contentBox.add(ticketsBox);

    const actionBox = new this.opentui.BoxRenderable(this.renderer, {
      border: true,
      title: 'Action Needed',
      width: '25%',
      flexDirection: 'column',
    });
    this.actionText = new this.opentui.TextRenderable(this.renderer, { content: '' });
    actionBox.add(this.actionText);
    contentBox.add(actionBox);

    const detailsBox = new this.opentui.BoxRenderable(this.renderer, {
      border: true,
      title: 'Details',
      width: '25%',
      flexDirection: 'column',
    });
    this.detailsText = new this.opentui.TextRenderable(this.renderer, { content: '' });
    detailsBox.add(this.detailsText);
    contentBox.add(detailsBox);

    root.add(contentBox);

    const eventsBox = new this.opentui.BoxRenderable(this.renderer, {
      border: true,
      title: 'Recent Events',
      height: 8,
      flexDirection: 'column',
    });
    this.eventsText = new this.opentui.TextRenderable(this.renderer, { content: '' });
    eventsBox.add(this.eventsText);
    root.add(eventsBox);

    this.renderer.root.add(root);
  }

  private registerInputHandler(): void {
    this.renderer.addInputHandler((sequence) => this.handleKey(sequence));
  }

  handleKey(sequence: string): boolean {
    if (this.destroyed) return false;
    switch (sequence) {
      case '\x1b[B': // Down arrow
      case 'j':
        this.state.selectNextTicket();
        this.refresh();
        return true;
      case '\x1b[A': // Up arrow
      case 'k':
        this.state.selectPreviousTicket();
        this.refresh();
        return true;
      case 'a':
      case '\t': // Tab
        this.state.selectNextActionNeeded();
        this.refresh();
        return true;
      default:
        return false;
    }
  }

  update(event: AgentExecutionProgressEvent): void {
    if (this.destroyed) return;
    this.state.ingest(event);
    this.refresh();
  }

  private refresh(): void {
    const snap = this.state.snapshot();
    this.headerText.content = [formatHeader(snap), formatAggregate(snap)].join('\n');
    this.featuresText.content = formatFeatures(snap);
    this.ticketsText.content = formatTickets(snap);
    this.actionText.content = formatActionNeeded(snap);
    this.detailsText.content = formatDetails(snap);
    this.eventsText.content = formatEvents(snap);
  }

  healthCheck(activeSessionIds: Set<string>): void {
    this.state.healthCheck(activeSessionIds);
    this.refresh();
  }

  done(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.renderer.destroy();
  }

  cleanup(): void {
    this.done();
  }
}

export async function createOpenTuiDashboard(
  options: OpenTuiDashboardOptions,
  opentuiModule?: OpenTuiDashboardModule,
): Promise<LiveRunView | null> {
  if (!options.stdout.isTTY) return null;

  let opentui: OpenTuiDashboardModule;
  try {
    opentui = opentuiModule ?? ((await import('@opentui/core')) as unknown as OpenTuiDashboardModule);
  } catch {
    return null;
  }

  try {
    const renderer = await opentui.createCliRenderer({
      stdout: options.stdout,
      screenMode: 'alternate-screen',
      clearOnShutdown: true,
      exitOnCtrlC: false,
      testing: false,
    });
    return new OpenTuiDashboard(renderer, options.selectedTickets ?? [], options.runOptions ?? {}, opentui);
  } catch {
    return null;
  }
}

export class DashboardProxy implements LiveRunView {
  private readonly fallback: ProgressLine;
  private dashboard: LiveRunView | null = null;
  private readonly buffer: AgentExecutionProgressEvent[] = [];
  private starting = false;
  private finalized = false;

  constructor(
    readonly stdout: NodeJS.WriteStream,
    readonly options: ProgressLineOptions,
    private readonly dashboardOptions: OpenTuiDashboardOptions,
    private readonly createDashboard: (opts: OpenTuiDashboardOptions) => Promise<LiveRunView | null>,
  ) {
    this.fallback = createProgressLine(stdout, options);
  }

  async start(): Promise<void> {
    if (this.starting || this.finalized) return;
    this.starting = true;
    let dashboard: LiveRunView | null = null;
    try {
      dashboard = await this.createDashboard(this.dashboardOptions);
    } catch {
      // fallback continues
    }
    if (this.finalized) {
      dashboard?.cleanup();
      this.buffer.length = 0;
      this.starting = false;
      return;
    }
    if (dashboard) {
      this.dashboard = dashboard;
      for (const event of this.buffer) {
        this.dashboard.update(event);
      }
    } else {
      for (const event of this.buffer) {
        this.fallback.update(event);
      }
    }
    this.buffer.length = 0;
    this.starting = false;
  }

  update(event: AgentExecutionProgressEvent): void {
    if (this.dashboard) {
      this.dashboard.update(event);
    } else if (this.starting && !this.finalized) {
      this.buffer.push(event);
    } else {
      this.fallback.update(event);
    }
  }

  healthCheck(activeSessionIds: Set<string>): void {
    if (this.dashboard && 'healthCheck' in this.dashboard) {
      (this.dashboard as unknown as { healthCheck(ids: Set<string>): void }).healthCheck(activeSessionIds);
    }
  }

  done(): void {
    this.finalized = true;
    const target = this.dashboard ?? this.fallback;
    for (const event of this.buffer) {
      target.update(event);
    }
    this.buffer.length = 0;
    this.dashboard?.done();
    this.fallback.done();
    this.buffer.length = 0;
  }

  cleanup(): void {
    this.finalized = true;
    const target = this.dashboard ?? this.fallback;
    for (const event of this.buffer) {
      target.update(event);
    }
    this.buffer.length = 0;
    this.dashboard?.cleanup();
    this.fallback.cleanup();
    this.buffer.length = 0;
  }
}
