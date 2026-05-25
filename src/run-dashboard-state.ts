import type { AgentExecutionProgressEvent, TicketRecord } from './types.js';

export type DashboardTicketRuntimeState = 'ready' | 'running' | 'blocked' | 'failed' | 'complete';

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
    total: number;
  };
  recentEvents: AgentExecutionProgressEvent[];
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
}

const MAX_RECENT_EVENTS = 50;

function isTerminalState(state: DashboardTicketRuntimeState): boolean {
  return state === 'complete' || state === 'failed' || state === 'blocked';
}

function inferRuntimeStateFromMessage(message: string): DashboardTicketRuntimeState | null {
  const lower = message.toLowerCase();
  if (lower.includes('run completed')) return 'complete';
  if (lower.includes('run blocked')) return 'blocked';
  if (lower.startsWith('run failed')) return 'failed';
  if (lower.includes('handoff')) return 'blocked';
  if (lower.includes('launcher context mismatch')) return 'blocked';
  if (lower.includes('run interrupted')) return 'failed';
  return null;
}

function computeFeatureAggregateState(tickets: DashboardTicketSnapshot[]): DashboardTicketRuntimeState {
  if (tickets.some((t) => t.runtimeState === 'running')) return 'running';
  if (tickets.some((t) => t.runtimeState === 'blocked')) return 'blocked';
  if (tickets.some((t) => t.runtimeState === 'failed')) return 'failed';
  if (tickets.every((t) => t.runtimeState === 'complete')) return 'complete';
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
      });
    }
  }

  ingest(event: AgentExecutionProgressEvent): void {
    const ticket = this.tickets.get(event.ticketLabel);
    if (ticket) {
      this.recentEvents.push(event);
      if (this.recentEvents.length > MAX_RECENT_EVENTS) {
        this.recentEvents.shift();
      }
    }

    if (!ticket) return;

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
      if (inferred === 'blocked') {
        const key = `${event.ticketLabel}:blocked:${event.message}`;
        if (!ticket.actionNeededKeys.has(key)) {
          ticket.actionNeededKeys.add(key);
          const item: ActionNeededSnapshot = {
            kind: 'blocked',
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

  setTicketOutcome(label: string, outcome: 'completed' | 'blocked' | 'failed' | 'not-scheduled'): void {
    const ticket = this.tickets.get(label);
    if (!ticket) return;

    const mapping: Record<typeof outcome, DashboardTicketRuntimeState> = {
      completed: 'complete',
      blocked: 'blocked',
      failed: 'failed',
      'not-scheduled': 'blocked',
    };
    ticket.runtimeState = mapping[outcome];

    if (outcome === 'blocked' || outcome === 'not-scheduled') {
      const key = `${label}:blocked:outcome:${outcome}`;
      if (!ticket.actionNeededKeys.has(key)) {
        ticket.actionNeededKeys.add(key);
        const item: ActionNeededSnapshot = {
          kind: 'blocked',
          ticketLabel: label,
          message:
            outcome === 'not-scheduled' ? 'Not scheduled because dependencies did not complete' : 'Ticket blocked',
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
      total: ticketSnapshots.length,
    };
    for (const ts of ticketSnapshots) {
      aggregate[ts.runtimeState] += 1;
    }

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
}
