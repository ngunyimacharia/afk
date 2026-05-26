import path from 'node:path';
import type { BoxRenderable, CliRenderer, TextRenderable } from '@opentui/core';
import { bold, cyan, dim, StyledText, stringToStyledText, t } from '@opentui/core';
import type { LiveRunView } from './live-run-view.js';
import type { ProgressLine, ProgressLineOptions } from './progress-line.js';
import { createProgressLine } from './progress-line.js';
import { classifyPathAgainstRepoRoot } from './repo-boundary.js';
import {
  type DashboardSnapshot,
  type DashboardTicketRuntimeState,
  RunDashboardState,
  type RunDashboardStateOptions,
} from './run-dashboard-state.js';
import type { AgentExecutionProgressEvent, TicketRecord } from './types.js';

export interface OpenTuiDashboardOptions {
  stdout: NodeJS.WriteStream;
  selectedTickets?: TicketRecord[];
  runOptions?: RunDashboardStateOptions;
  repoRoot?: string;
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
      borderColor?: string;
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

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  const hours = d.getHours().toString().padStart(2, '0');
  const minutes = d.getMinutes().toString().padStart(2, '0');
  const seconds = d.getSeconds().toString().padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function joinStyledTexts(items: StyledText[], separator: string): StyledText {
  const chunks = [];
  for (let i = 0; i < items.length; i++) {
    if (i > 0) {
      chunks.push(...stringToStyledText(separator).chunks);
    }
    chunks.push(...items[i].chunks);
  }
  return new StyledText(chunks);
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const TICKET_STATE_ICONS: Record<DashboardTicketRuntimeState, string> = {
  running: '⏳',
  complete: '✅',
  failed: '❌',
  ready: '⏸',
  blocked: '🚫',
  skipped: '⏭',
};

const FEATURE_STATE_ICONS: Record<DashboardTicketRuntimeState, string> = {
  running: '●',
  complete: '✅',
  failed: '❌',
  ready: '⏸',
  blocked: '🚫',
  skipped: '⏭',
};

export function stripFeaturePrefix(label: string): string {
  const slashIndex = label.indexOf('/');
  if (slashIndex === -1) return label;
  return label.slice(slashIndex + 1);
}

function formatPath(targetPath: string, repoRoot: string): string {
  const result = classifyPathAgainstRepoRoot(repoRoot, targetPath);
  if (result.classification === 'inside-repo') {
    return path.relative(repoRoot, targetPath);
  }
  return path.basename(targetPath);
}

function formatHeader(snap: DashboardSnapshot, runComplete: boolean): StyledText {
  const elapsed = formatElapsed(snap.elapsedMs);
  const parts: StyledText[] = [];
  if (snap.runId) parts.push(t`${dim('Run:')} ${bold(snap.runId)}`);
  if (snap.modelId) parts.push(t`${dim('Model:')} ${snap.modelId}`);
  if (snap.harness) parts.push(t`${dim('Harness:')} ${snap.harness}`);
  if (snap.concurrency) parts.push(t`${dim('Concurrency:')} ${String(snap.concurrency)}`);
  parts.push(t`${dim('Elapsed:')} ${bold(elapsed)}`);
  const header = joinStyledTexts(parts, ' | ');
  if (runComplete) {
    return joinStyledTexts([header, t`${bold('All tasks complete')}`], '\n');
  }
  return header;
}

function formatAggregate(snap: DashboardSnapshot): StyledText {
  const parts: StyledText[] = [];
  parts.push(t`${dim('Ready:')} ${bold(String(snap.aggregate.ready))}`);
  parts.push(t`${dim('Running:')} ${cyan(bold(String(snap.aggregate.running)))}`);
  parts.push(t`${dim('Blocked:')} ${bold(String(snap.aggregate.blocked))}`);
  parts.push(t`${dim('Failed:')} ${bold(String(snap.aggregate.failed))}`);
  parts.push(t`${dim('Complete:')} ${bold(String(snap.aggregate.complete))}`);
  parts.push(t`${dim('Skipped:')} ${bold(String(snap.aggregate.skipped))}`);
  return joinStyledTexts(parts, ' | ');
}

function formatFeatures(snap: DashboardSnapshot): StyledText {
  if (snap.features.length === 0) return stringToStyledText('No features');
  const parts = snap.features.map((f) => {
    const icon =
      f.aggregateState === 'running' ? cyan(FEATURE_STATE_ICONS.running) : FEATURE_STATE_ICONS[f.aggregateState];
    const count = f.tickets.length;
    return t`${icon} ${f.feature} ${dim(`(${count} ticket${count === 1 ? '' : 's'})`)}`;
  });
  return joinStyledTexts(parts, '\n');
}

function formatTickets(snap: DashboardSnapshot, frameCounter: number): StyledText {
  if (snap.tickets.length === 0) return stringToStyledText('No tickets');
  const parts = snap.tickets.map((ticket) => {
    const icon =
      ticket.runtimeState === 'running'
        ? cyan(SPINNER_FRAMES[frameCounter % SPINNER_FRAMES.length])
        : TICKET_STATE_ICONS[ticket.runtimeState];
    const selected = snap.selectedTicket?.label === ticket.label ? '>' : ' ';
    return t`${selected} ${stripFeaturePrefix(ticket.label)} ${icon}`;
  });
  return joinStyledTexts(parts, '\n');
}

function formatActionNeeded(snap: DashboardSnapshot): StyledText {
  if (snap.actionNeeded.length === 0) return stringToStyledText('No action needed');
  const parts = snap.actionNeeded.map(
    (a) => t`${dim(`[${a.kind}]`)} ${stripFeaturePrefix(a.ticketLabel)}: ${a.message.slice(0, 60)}`,
  );
  return joinStyledTexts(parts, '\n');
}

function formatEvents(snap: DashboardSnapshot): StyledText {
  if (snap.recentEvents.length === 0) return stringToStyledText('No events yet');
  const parts = snap.recentEvents.slice(-10).map((e) => {
    const time = e.timestamp ? formatTime(e.timestamp) : '--:--:--';
    return t`${dim(time)} ${stripFeaturePrefix(e.ticketLabel)}: ${e.message.slice(0, 80)}`;
  });
  return joinStyledTexts(parts, '\n');
}

function formatDetails(snap: DashboardSnapshot, repoRoot: string): StyledText {
  const details = snap.selectedTicketDetails;
  if (!details) {
    if (snap.tickets.length === 0) return stringToStyledText('No tickets in run');
    return stringToStyledText('Select a ticket to view details');
  }

  const lines: StyledText[] = [];
  const stateIcon =
    details.runtimeState === 'running' ? cyan(TICKET_STATE_ICONS.running) : TICKET_STATE_ICONS[details.runtimeState];
  lines.push(t`${stripFeaturePrefix(details.label)} ${stateIcon}`);
  lines.push(t`${dim('Path:')} ${formatPath(details.path, repoRoot)}`);
  if (details.status) lines.push(t`${dim('Status:')} ${details.status}`);
  if (details.sessionId) lines.push(t`${dim('Session:')} ${details.sessionId}`);
  if (snap.modelId) lines.push(t`${dim('Model:')} ${snap.modelId}`);
  if (snap.harness) lines.push(t`${dim('Harness:')} ${snap.harness}`);
  if (details.dependencies.length > 0) lines.push(t`${dim('Deps:')} ${details.dependencies.join(', ')}`);
  if (details.failureKind) lines.push(t`${dim('Failure:')} ${details.failureKind}`);
  if (details.reviewOutcome) {
    const review = details.reviewReason ? `${details.reviewOutcome} (${details.reviewReason})` : details.reviewOutcome;
    lines.push(t`${dim('Review:')} ${review}`);
  }
  if (details.actionNeededCount > 0) lines.push(t`${dim('Action needed:')} ${String(details.actionNeededCount)}`);

  if (details.phaseHistory.length > 0) {
    lines.push(t`${dim('Phases:')}`);
    for (const phase of details.phaseHistory.slice(-5)) {
      lines.push(t`  ${phase.name} ${dim(`${phase.durationMs}ms`)}`);
    }
  }

  return joinStyledTexts(lines, '\n');
}

class OpenTuiDashboard implements LiveRunView {
  private destroyed = false;
  private runComplete = false;
  private readonly state: RunDashboardState;
  private headerText!: TextRenderable;
  private featuresText!: TextRenderable;
  private ticketsText!: TextRenderable;
  private actionText!: TextRenderable;
  private eventsText!: TextRenderable;
  private detailsText!: TextRenderable;
  private footerText!: TextRenderable;
  private timer: ReturnType<typeof setInterval> | null = null;
  private quitTimeout: ReturnType<typeof setTimeout> | null = null;
  private quitArmed = false;
  private quitResolver: (() => void) | null = null;
  private readonly quitPromise: Promise<void>;
  private frameCounter = 0;

  constructor(
    private readonly renderer: CliRenderer,
    selectedTickets: TicketRecord[],
    runOptions: RunDashboardStateOptions,
    private readonly opentui: OpenTuiDashboardModule,
    private readonly repoRoot: string,
  ) {
    this.state = new RunDashboardState(runOptions, selectedTickets);
    this.quitPromise = new Promise((resolve) => {
      this.quitResolver = resolve;
    });
    this.buildLayout();
    this.registerInputHandler();
    this.refresh();
    this.startTimer();
  }

  private startTimer(): void {
    if (this.destroyed) return;
    this.timer = setInterval(() => {
      if (this.destroyed) return;
      this.frameCounter += 1;
      this.refresh();
    }, 200);
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private clearQuitTimeout(): void {
    if (this.quitTimeout !== null) {
      clearTimeout(this.quitTimeout);
      this.quitTimeout = null;
    }
  }

  private armQuit(): void {
    if (this.destroyed) return;
    this.quitArmed = true;
    this.refresh();
    this.clearQuitTimeout();
    this.quitTimeout = setTimeout(() => {
      this.disarmQuit();
    }, 2000);
  }

  private disarmQuit(): void {
    if (this.destroyed) return;
    this.quitArmed = false;
    this.clearQuitTimeout();
    this.refresh();
  }

  private confirmQuit(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopTimer();
    this.clearQuitTimeout();
    this.renderer.destroy();
    this.quitResolver?.();
  }

  private checkRunComplete(snap: DashboardSnapshot): boolean {
    if (snap.aggregate.total === 0) return false;
    return snap.tickets.every(
      (t) =>
        t.runtimeState === 'complete' ||
        t.runtimeState === 'failed' ||
        t.runtimeState === 'blocked' ||
        t.runtimeState === 'skipped',
    );
  }

  private maybeStopTimer(snap: DashboardSnapshot): void {
    if (this.timer === null) return;
    const allTerminal =
      snap.tickets.length === 0 ||
      snap.tickets.every(
        (t) =>
          t.runtimeState === 'complete' ||
          t.runtimeState === 'failed' ||
          t.runtimeState === 'blocked' ||
          t.runtimeState === 'skipped',
      );
    if (allTerminal) {
      this.stopTimer();
    }
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
      borderColor: '#888888',
      title: 'AFK Run Dashboard',
      titleAlignment: 'center',
      flexDirection: 'column',
    });
    this.headerText = new this.opentui.TextRenderable(this.renderer, { content: '' });
    headerBox.add(this.headerText);
    root.add(headerBox);

    const contentBox = new this.opentui.BoxRenderable(this.renderer, {
      flexDirection: 'row',
      flexGrow: 2,
      gap: 1,
    });

    const featuresBox = new this.opentui.BoxRenderable(this.renderer, {
      border: true,
      borderColor: '#888888',
      title: 'Features [j/k]',
      width: '25%',
      flexDirection: 'column',
    });
    this.featuresText = new this.opentui.TextRenderable(this.renderer, { content: '' });
    featuresBox.add(this.featuresText);
    contentBox.add(featuresBox);

    const ticketsBox = new this.opentui.BoxRenderable(this.renderer, {
      border: true,
      borderColor: '#888888',
      title: 'Tickets [j/k]',
      width: '25%',
      flexDirection: 'column',
    });
    this.ticketsText = new this.opentui.TextRenderable(this.renderer, { content: '' });
    ticketsBox.add(this.ticketsText);
    contentBox.add(ticketsBox);

    const actionBox = new this.opentui.BoxRenderable(this.renderer, {
      border: true,
      borderColor: '#888888',
      title: 'Action Needed [a]',
      width: '25%',
      flexDirection: 'column',
    });
    this.actionText = new this.opentui.TextRenderable(this.renderer, { content: '' });
    actionBox.add(this.actionText);
    contentBox.add(actionBox);

    const detailsBox = new this.opentui.BoxRenderable(this.renderer, {
      border: true,
      borderColor: '#888888',
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
      borderColor: '#888888',
      title: 'Recent Events',
      flexGrow: 1,
      flexDirection: 'column',
    });
    this.eventsText = new this.opentui.TextRenderable(this.renderer, { content: '' });
    eventsBox.add(this.eventsText);
    root.add(eventsBox);

    const footerBox = new this.opentui.BoxRenderable(this.renderer, {
      flexDirection: 'column',
      height: 1,
    });
    this.footerText = new this.opentui.TextRenderable(this.renderer, { content: '' });
    footerBox.add(this.footerText);
    root.add(footerBox);

    this.renderer.root.add(root);
  }

  private registerInputHandler(): void {
    this.renderer.addInputHandler((sequence) => this.handleKey(sequence));
  }

  handleKey(sequence: string): boolean {
    if (this.destroyed) return false;
    switch (sequence) {
      case '\x03': // Ctrl+C
      case 'q':
        if (this.quitArmed) {
          this.confirmQuit();
        } else {
          this.armQuit();
        }
        return true;
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
    const snap = this.state.snapshot();
    if (!this.runComplete && this.checkRunComplete(snap)) {
      this.runComplete = true;
      this.refresh();
    }
  }

  private refresh(): void {
    const snap = this.state.snapshot();
    this.headerText.content = joinStyledTexts([formatHeader(snap, this.runComplete), formatAggregate(snap)], '\n');
    this.featuresText.content = formatFeatures(snap);
    this.ticketsText.content = formatTickets(snap, this.frameCounter);
    this.actionText.content = formatActionNeeded(snap);
    this.detailsText.content = formatDetails(snap, this.repoRoot);
    this.eventsText.content = formatEvents(snap);
    this.footerText.content = this.quitArmed ? 'Press again to quit' : 'Ctrl+C or q to quit';
    this.maybeStopTimer(snap);
  }

  healthCheck(activeSessionIds: Set<string>): void {
    this.state.healthCheck(activeSessionIds);
    this.refresh();
  }

  done(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopTimer();
    this.clearQuitTimeout();
    this.renderer.destroy();
    this.quitResolver?.();
  }

  cleanup(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopTimer();
    this.clearQuitTimeout();
    this.renderer.destroy();
    this.quitResolver?.();
  }

  waitForQuit(): Promise<void> {
    return this.quitPromise;
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
    return new OpenTuiDashboard(
      renderer,
      options.selectedTickets ?? [],
      options.runOptions ?? {},
      opentui,
      options.repoRoot ?? process.cwd(),
    );
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

  waitForQuit(): Promise<void> {
    return this.dashboard?.waitForQuit() ?? this.fallback.waitForQuit();
  }
}
