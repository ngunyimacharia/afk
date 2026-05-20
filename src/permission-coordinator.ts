import prompts from 'prompts';
import type { OpenCodePermissionDecision, OpenCodePermissionRequest } from './opencode.js';

export type PermissionCoordinatorDecision = OpenCodePermissionDecision;

export interface PermissionPromptMetadata {
  ticketLabel: string;
  sessionId: string;
  permissionId: string;
  type: string;
  title: string;
  patterns: string[];
  queuedCount: number;
}

export interface PermissionPromptInput {
  request: Readonly<OpenCodePermissionRequest>;
  metadata: Readonly<PermissionPromptMetadata>;
  message: string;
}

export type PermissionPromptAdapter = (input: PermissionPromptInput) => Promise<PermissionCoordinatorDecision | null | undefined>;

export type PermissionSafeDefaultReason =
  | 'prompt-cancelled'
  | 'non-interactive-tty'
  | 'invalid-decision'
  | 'prompt-failure';

export interface PermissionDecisionHistoryEntry {
  order: number;
  recordedAt: string;
  request: OpenCodePermissionRequest;
  metadata: PermissionPromptMetadata;
  decision: PermissionCoordinatorDecision;
  safeDefaultReason?: PermissionSafeDefaultReason;
}

interface QueuedPermissionRequest {
  request: OpenCodePermissionRequest;
  order: number;
  resolve: (decision: PermissionCoordinatorDecision) => void;
}

export interface PermissionCoordinatorOptions {
  ticketLabel: string;
  promptAdapter?: PermissionPromptAdapter;
  now?: () => Date;
}

export class PermissionPromptCancelledError extends Error {
  constructor(message = 'manual permission prompt cancelled') {
    super(message);
    this.name = 'PermissionPromptCancelledError';
  }
}

export class PermissionPromptNonInteractiveError extends Error {
  constructor(message = 'interactive terminal is unavailable') {
    super(message);
    this.name = 'PermissionPromptNonInteractiveError';
  }
}

export class PermissionCoordinator {
  private readonly ticketLabel: string;
  private readonly promptAdapter: PermissionPromptAdapter;
  private readonly now: () => Date;
  private readonly queue: QueuedPermissionRequest[] = [];
  private readonly historyEntries: PermissionDecisionHistoryEntry[] = [];
  private active = false;
  private drainScheduled = false;
  private nextOrder = 1;

  constructor(options: PermissionCoordinatorOptions) {
    this.ticketLabel = options.ticketLabel;
    this.promptAdapter = options.promptAdapter ?? createManualPermissionPromptAdapter();
    this.now = options.now ?? (() => new Date());
  }

  get promptActive(): boolean {
    return this.active;
  }

  get history(): readonly PermissionDecisionHistoryEntry[] {
    return this.historyEntries;
  }

  async submit(request: OpenCodePermissionRequest): Promise<PermissionCoordinatorDecision> {
    return new Promise((resolve) => {
      this.queue.push({ request: cloneRequest(request), resolve, order: this.nextOrder++ });
      this.scheduleDrain();
    });
  }

  formatHistorySummary(): string {
    return formatPermissionHistorySummary(this.historyEntries);
  }

  private drainQueue(): void {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = true;
    void this.processRequest(next).finally(() => {
      this.active = false;
      this.drainQueue();
    });
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drainQueue();
    });
  }

  private async processRequest(item: QueuedPermissionRequest): Promise<void> {
    const metadata = this.createPromptMetadata(item.request);
    const renderedMessage = formatPermissionPromptMessage(metadata);
    let decision: PermissionCoordinatorDecision = 'reject';
    let safeDefaultReason: PermissionSafeDefaultReason | undefined;
    try {
      const value = await this.promptAdapter({ request: cloneRequest(item.request), metadata, message: renderedMessage });
      if (value === 'once' || value === 'always' || value === 'reject') {
        decision = value;
      } else {
        safeDefaultReason = 'invalid-decision';
      }
    } catch (error) {
      safeDefaultReason = classifyPromptFailure(error);
    }

    this.historyEntries.push({
      order: item.order,
      recordedAt: this.now().toISOString(),
      request: cloneRequest(item.request),
      metadata,
      decision,
      safeDefaultReason,
    });
    item.resolve(decision);
  }

  private createPromptMetadata(request: OpenCodePermissionRequest): PermissionPromptMetadata {
    const sessionId = request.sessionId.trim() || 'unknown';
    return {
      ticketLabel: this.ticketLabel,
      sessionId,
      permissionId: request.permissionId,
      type: request.type,
      title: request.title,
      patterns: [...request.patterns],
      queuedCount: this.queue.length,
    };
  }
}

export function createManualPermissionPromptAdapter(): PermissionPromptAdapter {
  return async ({ metadata, message }) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new PermissionPromptNonInteractiveError();
    }

    const response = await prompts(
      {
        type: 'select',
        name: 'decision',
        message,
        choices: [
          { title: 'Allow once', value: 'once' },
          { title: 'Always allow', value: 'always' },
          { title: 'Reject', value: 'reject' },
        ],
        initial: 0,
      },
      {
        onCancel: () => {
          throw new PermissionPromptCancelledError(
            `manual decision cancelled for ${metadata.permissionId}`,
          );
        },
      },
    );

    return response.decision;
  };
}

export function formatPermissionPromptMessage(metadata: PermissionPromptMetadata): string {
  const lines = [
    'OpenCode permission review required',
    `Ticket: ${metadata.ticketLabel}`,
    `Session: ${metadata.sessionId || 'unknown'}`,
    `Permission ID: ${metadata.permissionId}`,
    `Type: ${metadata.type}`,
    `Title: ${metadata.title}`,
    `Queued: ${metadata.queuedCount}`,
  ];
  if (metadata.patterns.length) lines.push(`Patterns: ${metadata.patterns.join(', ')}`);
  return lines.join('\n');
}

export function formatPermissionHistorySummary(history: readonly PermissionDecisionHistoryEntry[]): string {
  if (!history.length) return 'No manual permission decisions recorded.';
  return history
    .map((entry) => {
      const reason = entry.safeDefaultReason ? ` (${entry.safeDefaultReason})` : '';
      const patterns = entry.metadata.patterns.length ? ` [${entry.metadata.patterns.join(', ')}]` : '';
      return `#${entry.order} ${entry.decision}${reason} ${entry.metadata.type}${patterns}`;
    })
    .join('\n');
}

function classifyPromptFailure(error: unknown): PermissionSafeDefaultReason {
  if (error instanceof PermissionPromptCancelledError) return 'prompt-cancelled';
  if (error instanceof PermissionPromptNonInteractiveError) return 'non-interactive-tty';
  return 'prompt-failure';
}

function cloneRequest(request: OpenCodePermissionRequest): OpenCodePermissionRequest {
  return {
    sessionId: request.sessionId,
    permissionId: request.permissionId,
    type: request.type,
    title: request.title,
    patterns: [...request.patterns],
  };
}
