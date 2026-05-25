import type { AgentExecutionProgressEvent, PhaseHistoryEntry, RuntimeMetadataRecord, TicketRecord } from './types.js';

export type DashboardTicketRuntimeState = 'ready' | 'running' | 'blocked' | 'failed' | 'complete' | 'skipped';

export interface DashboardTicketSnapshot {
  label: string;
  feature: string;
  issueName: string;
  path: string;
  status?: string;
  latestMessage: string;
  sessionId: string | null;
  hasPermission: boolean;
  hasFailure: boolean;
  actionNeededCount: number;
  runtimeState: DashboardTicketRuntimeState;
}

export interface DashboardFeatureSnapshot {
  feature: string;
  tickets: DashboardTicketSnapshot[];
  aggregateState: DashboardTicketRuntimeState;
}

export interface ActionNeededSnapshot {
  kind: 'permission' | 'failure' | 'blocked';
  ticketLabel: string;
  message: string;
  timestamp: number;
}

export interface SelectedTicketDetails {
  label: string;
  feature: string;
  issueName: string;
  path: string;
  status?: string;
  dependencies: string[];
  latestMessage: string;
  runtimeState: DashboardTicketRuntimeState;
  sessionId: string | null;
  hasPermission: boolean;
  hasFailure: boolean;
  actionNeededCount: number;
  failureKind?: string | null;
  reviewOutcome?: string | null;
  reviewReason?: string | null;
  reviewClassification?: string | null;
  phaseHistory: PhaseHistoryEntry[];
  recentEvents: AgentExecutionProgressEvent[];
}

export interface DashboardSnapshot {
  runId?: string;
  modelId?: string;
  harness?: string;
  reviewerModelId?: string;
  reviewerHarness?: string;
  concurrency?: number;
  startTime: number;
  elapsedMs: number;
  features: DashboardFeatureSnapshot[];
  tickets: DashboardTicketSnapshot[];
  actionNeeded: ActionNeededSnapshot[];
  aggregate: {
    running: number;
    blocked: number;
    failed: number;
    complete: number;
    ready: number;
    skipped: number;
    total: number;
  };
  recentEvents: AgentExecutionProgressEvent[];
  selectedTicket: DashboardTicketSnapshot | null;
  selectedTicketDetails: SelectedTicketDetails | null;
}

export interface RunDashboardStateOptions {
  runId?: string;
  modelId?: string;
  harness?: string;
  reviewerModelId?: string;
  reviewerHarness?: string;
  concurrency?: number;
  startTime?: number;
  now?: () => number;
}

interface InternalTicketState {
  record: TicketRecord;
  latestMessage: string;
  sessionId: string | null;
  hasPermission: boolean;
  hasFailure: boolean;
  runtimeState: DashboardTicketRuntimeState;
  actionNeededKeys: Set<string>;
  metadata: Partial<RuntimeMetadataRecord>;
}

const MAX_RECENT_EVENTS = 50;

function isTerminalState(state: DashboardTicketRuntimeState): boolean {
  return state === 'complete' || state === 'failed' || state === 'blocked' || state === 'skipped';
}

function inferRuntimeStateFromMessage(message: string): DashboardTicketRuntimeState | null {
  const lower = message.toLowerCase();
  if (lower.includes('run completed')) return 'complete';
  if (lower.includes('run blocked')) return 'blocked';
  if (lower.startsWith('run failed')) return 'failed';
  if (lower.includes('run interrupted')) return 'failed';
  return null;
}

function computeFeatureAggregateState(tickets: DashboardTicketSnapshot[]): DashboardTicketRuntimeState {
  if (tickets.some((t) => t.runtimeState === 'running')) return 'running';
  if (tickets.some((t) => t.runtimeState === 'blocked')) return 'blocked';
  if (tickets.some((t) => t.runtimeState === 'failed')) return 'failed';
  if (tickets.every((t) => isTerminalState(t.runtimeState))) {
    if (tickets.some((t) => t.runtimeState === 'skipped')) return 'skipped';
    if (tickets.every((t) => t.runtimeState === 'complete')) return 'complete';
  }
  return 'ready';
}

function initialRuntimeState(ticket: TicketRecord): DashboardTicketRuntimeState {
  const normalized = ticket.status?.trim().toLowerCase();
  if (normalized === 'done' || normalized === 'closed' || normalized === 'complete' || normalized === 'resolved') {
    return 'complete';
  }
  return 'ready';
}

export class RunDashboardState {
  private readonly tickets = new Map<string, InternalTicketState>();
  private readonly actionNeeded = new Map<string, ActionNeededSnapshot>();
  private readonly recentEvents: AgentExecutionProgressEvent[] = [];
  private readonly options: RunDashboardStateOptions;
  private readonly startTime: number;
  private readonly now: () => number;
  private selectedTicketLabel: string | null = null;

  constructor(options: RunDashboardStateOptions = {}, selectedTickets: TicketRecord[] = []) {
    this.options = options;
    this.startTime = options.startTime ?? Date.now();
    this.now = options.now ?? Date.now;
    for (const ticket of selectedTickets) {
      this.tickets.set(ticket.label, {
        record: ticket,
        latestMessage: '',
        sessionId: null,
        hasPermission: false,
        hasFailure: false,
        runtimeState: initialRuntimeState(ticket),
        actionNeededKeys: new Set(),
        metadata: {},
      });
    }
    if (selectedTickets.length > 0) {
      this.selectedTicketLabel = selectedTickets[0].label;
    }
  }

  ingest(event: AgentExecutionProgressEvent): void {
    const eventWithTimestamp: AgentExecutionProgressEvent = {
      ...event,
      timestamp: event.timestamp ?? this.now(),
    };
    const ticket = this.tickets.get(event.ticketLabel);
    if (ticket) {
      this.recentEvents.push(eventWithTimestamp);
      if (this.recentEvents.length > MAX_RECENT_EVENTS) {
        this.recentEvents.shift();
      }
    }

    if (!ticket) return;

    if (event.metadata) {
      this.ingestMetadata(event.ticketLabel, event.metadata);
    }

    ticket.latestMessage = event.message;
    if (event.sessionId !== undefined && event.sessionId !== null) {
      ticket.sessionId = event.sessionId;
    }

    if (event.kind === 'permission') {
      ticket.hasPermission = true;
      const key = `${event.ticketLabel}:permission:${event.message}`;
      if (!ticket.actionNeededKeys.has(key)) {
        ticket.actionNeededKeys.add(key);
        const item: ActionNeededSnapshot = {
          kind: 'permission',
          ticketLabel: event.ticketLabel,
          message: event.message,
          timestamp: this.now(),
        };
        this.actionNeeded.set(key, item);
      }
      if (!isTerminalState(ticket.runtimeState)) {
        ticket.runtimeState = 'running';
      }
      return;
    }

    if (event.kind === 'failure') {
      ticket.hasFailure = true;
      const key = `${event.ticketLabel}:failure:${event.message}`;
      if (!ticket.actionNeededKeys.has(key)) {
        ticket.actionNeededKeys.add(key);
        const item: ActionNeededSnapshot = {
          kind: 'failure',
          ticketLabel: event.ticketLabel,
          message: event.message,
          timestamp: this.now(),
        };
        this.actionNeeded.set(key, item);
      }
      if (!isTerminalState(ticket.runtimeState)) {
        ticket.runtimeState = 'running';
      }
      return;
    }

    const inferred = inferRuntimeStateFromMessage(event.message);
    if (inferred !== null) {
      ticket.runtimeState = inferred;
      if (inferred === 'blocked' || inferred === 'failed') {
        const kind: 'blocked' | 'failure' = inferred === 'blocked' ? 'blocked' : 'failure';
        const key = `${event.ticketLabel}:${kind}:${event.message}`;
        if (!ticket.actionNeededKeys.has(key)) {
          ticket.actionNeededKeys.add(key);
          const item: ActionNeededSnapshot = {
            kind,
            ticketLabel: event.ticketLabel,
            message: event.message,
            timestamp: this.now(),
          };
          this.actionNeeded.set(key, item);
        }
      }
      return;
    }

    if (!isTerminalState(ticket.runtimeState)) {
      ticket.runtimeState = 'running';
    }
  }

  ingestMetadata(label: string, metadata: Partial<RuntimeMetadataRecord>): void {
    const ticket = this.tickets.get(label);
    if (!ticket) return;
    ticket.metadata = { ...ticket.metadata, ...metadata };
  }

  selectTicket(label: string | null): void {
    if (label === null) {
      this.selectedTicketLabel = null;
      return;
    }
    if (this.tickets.has(label)) {
      this.selectedTicketLabel = label;
    }
  }

  selectNextTicket(): void {
    const labels = Array.from(this.tickets.keys());
    if (labels.length === 0) {
      this.selectedTicketLabel = null;
      return;
    }
    if (this.selectedTicketLabel === null) {
      this.selectedTicketLabel = labels[0];
      return;
    }
    const idx = labels.indexOf(this.selectedTicketLabel);
    const nextIdx = idx >= 0 && idx < labels.length - 1 ? idx + 1 : 0;
    this.selectedTicketLabel = labels[nextIdx];
  }

  selectPreviousTicket(): void {
    const labels = Array.from(this.tickets.keys());
    if (labels.length === 0) {
      this.selectedTicketLabel = null;
      return;
    }
    if (this.selectedTicketLabel === null) {
      this.selectedTicketLabel = labels[labels.length - 1];
      return;
    }
    const idx = labels.indexOf(this.selectedTicketLabel);
    const prevIdx = idx > 0 ? idx - 1 : labels.length - 1;
    this.selectedTicketLabel = labels[prevIdx];
  }

  selectNextActionNeeded(): void {
    const labels = Array.from(this.tickets.keys());
    if (labels.length === 0) {
      this.selectedTicketLabel = null;
      return;
    }
    const actionLabels = new Set(
      labels.filter((l) => {
        const t = this.tickets.get(l);
        return t && t.actionNeededKeys.size > 0;
      }),
    );
    if (actionLabels.size === 0) {
      // No action-needed items; keep current selection
      return;
    }
    if (this.selectedTicketLabel === null) {
      this.selectedTicketLabel = labels.find((l) => actionLabels.has(l)) ?? null;
      return;
    }
    const currentIdx = labels.indexOf(this.selectedTicketLabel);
    for (let offset = 1; offset <= labels.length; offset++) {
      const idx = (currentIdx + offset) % labels.length;
      if (actionLabels.has(labels[idx])) {
        this.selectedTicketLabel = labels[idx];
        return;
      }
    }
  }

  healthCheck(activeSessionIds: Set<string>): void {
    for (const ticket of this.tickets.values()) {
      if (ticket.runtimeState === 'running' && ticket.sessionId !== null && !activeSessionIds.has(ticket.sessionId)) {
        ticket.runtimeState = 'complete';
      }
    }
  }

  setTicketOutcome(label: string, outcome: 'completed' | 'blocked' | 'failed' | 'not-scheduled' | 'skipped'): void {
    const ticket = this.tickets.get(label);
    if (!ticket) return;

    const mapping: Record<typeof outcome, DashboardTicketRuntimeState> = {
      completed: 'complete',
      blocked: 'blocked',
      failed: 'failed',
      'not-scheduled': 'skipped',
      skipped: 'skipped',
    };
    ticket.runtimeState = mapping[outcome];

    if (outcome === 'blocked') {
      const key = `${label}:blocked:outcome:${outcome}`;
      if (!ticket.actionNeededKeys.has(key)) {
        ticket.actionNeededKeys.add(key);
        const item: ActionNeededSnapshot = {
          kind: 'blocked',
          ticketLabel: label,
          message: 'Ticket blocked',
          timestamp: this.now(),
        };
        this.actionNeeded.set(key, item);
      }
    }
  }

  snapshot(): DashboardSnapshot {
    const ticketSnapshots = Array.from(this.tickets.values()).map((t) => this.toTicketSnapshot(t));
    const featuresMap = new Map<string, DashboardTicketSnapshot[]>();
    for (const ts of ticketSnapshots) {
      const list = featuresMap.get(ts.feature) ?? [];
      list.push(ts);
      featuresMap.set(ts.feature, list);
    }
    const features: DashboardFeatureSnapshot[] = Array.from(featuresMap.entries()).map(([feature, tickets]) => ({
      feature,
      tickets,
      aggregateState: computeFeatureAggregateState(tickets),
    }));

    const aggregate = {
      running: 0,
      blocked: 0,
      failed: 0,
      complete: 0,
      ready: 0,
      skipped: 0,
      total: ticketSnapshots.length,
    };
    for (const ts of ticketSnapshots) {
      aggregate[ts.runtimeState] += 1;
    }

    const selectedTicket = this.selectedTicketLabel
      ? (ticketSnapshots.find((t) => t.label === this.selectedTicketLabel) ?? null)
      : null;

    return {
      runId: this.options.runId,
      modelId: this.options.modelId,
      harness: this.options.harness,
      reviewerModelId: this.options.reviewerModelId,
      reviewerHarness: this.options.reviewerHarness,
      concurrency: this.options.concurrency,
      startTime: this.startTime,
      elapsedMs: this.now() - this.startTime,
      features,
      tickets: ticketSnapshots,
      actionNeeded: Array.from(this.actionNeeded.values()).map((a) => structuredClone(a)),
      aggregate,
      recentEvents: this.recentEvents.map((e) => structuredClone(e)),
      selectedTicket,
      selectedTicketDetails: selectedTicket ? this.buildSelectedTicketDetails(selectedTicket) : null,
    };
  }

  private toTicketSnapshot(ticket: InternalTicketState): DashboardTicketSnapshot {
    return {
      label: ticket.record.label,
      feature: ticket.record.feature,
      issueName: ticket.record.issueName,
      path: ticket.record.path,
      status: ticket.record.status,
      latestMessage: ticket.latestMessage,
      sessionId: ticket.sessionId,
      hasPermission: ticket.hasPermission,
      hasFailure: ticket.hasFailure,
      actionNeededCount: ticket.actionNeededKeys.size,
      runtimeState: ticket.runtimeState,
    };
  }

  private buildSelectedTicketDetails(ticket: DashboardTicketSnapshot): SelectedTicketDetails {
    const internal = this.tickets.get(ticket.label);
    const metadata = internal?.metadata ?? {};
    const ticketRecentEvents = this.recentEvents.filter((e) => e.ticketLabel === ticket.label).slice(-10);
    return {
      label: ticket.label,
      feature: ticket.feature,
      issueName: ticket.issueName,
      path: ticket.path,
      status: ticket.status,
      dependencies: internal?.record.dependsOn ?? [],
      latestMessage: ticket.latestMessage,
      runtimeState: ticket.runtimeState,
      sessionId: ticket.sessionId,
      hasPermission: ticket.hasPermission,
      hasFailure: ticket.hasFailure,
      actionNeededCount: ticket.actionNeededCount,
      failureKind: metadata.FAILURE_KIND,
      reviewOutcome: metadata.FINAL_REVIEW_OUTCOME ?? undefined,
      reviewReason: metadata.FINAL_REVIEW_REASON ?? undefined,
      reviewClassification: metadata.FINAL_REVIEW_CLASSIFICATION ?? undefined,
      phaseHistory: metadata.PHASE_HISTORY ?? [],
      recentEvents: ticketRecentEvents.map((e) => structuredClone(e)),
    };
  }
}
