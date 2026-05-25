import type { AgentExecutionProgressEvent } from './types.js';

export type NotificationCategory =
  | 'permission-required'
  | 'ticket-blocked'
  | 'ticket-failed'
  | 'run-completed-success'
  | 'run-completed-with-issues';

export interface NotificationPayload {
  title: string;
  message: string;
  category: NotificationCategory;
}

export interface NotificationPolicyEvent {
  kind: NotificationCategory;
  ticketLabel?: string;
  permissionKey?: string;
  message?: string;
  runId?: string;
  ticketCount?: number;
  failedCount?: number;
  blockedCount?: number;
}

/**
 * Pure notification policy that deduplicates action-needed and terminal-run
 * events.  It is safe to call {@link maybeNotify} repeatedly with the same
 * input: only the first notify-worthy occurrence produces a payload.
 */
export class NotificationPolicy {
  private readonly notifiedPermissions = new Set<string>();
  private readonly notifiedTickets = new Set<string>();
  private runOutcomeNotified = false;

  maybeNotify(event: NotificationPolicyEvent): NotificationPayload | null {
    switch (event.kind) {
      case 'permission-required': {
        const key = event.permissionKey ?? `${event.ticketLabel ?? 'unknown'}:${event.message ?? 'unknown'}`;
        if (this.notifiedPermissions.has(key)) return null;
        this.notifiedPermissions.add(key);
        return {
          title: `Permission required: ${event.ticketLabel ?? 'unknown'}`,
          message: event.message ?? 'A permission request needs your attention.',
          category: 'permission-required',
        };
      }
      case 'ticket-blocked': {
        const key = `${event.ticketLabel ?? 'unknown'}:blocked`;
        if (this.notifiedTickets.has(key)) return null;
        this.notifiedTickets.add(key);
        return {
          title: `Blocked: ${event.ticketLabel ?? 'unknown'}`,
          message: event.message ?? 'The ticket is blocked and needs human handoff.',
          category: 'ticket-blocked',
        };
      }
      case 'ticket-failed': {
        const key = `${event.ticketLabel ?? 'unknown'}:failed`;
        if (this.notifiedTickets.has(key)) return null;
        this.notifiedTickets.add(key);
        return {
          title: `Failed: ${event.ticketLabel ?? 'unknown'}`,
          message: event.message ?? 'The ticket failed during execution.',
          category: 'ticket-failed',
        };
      }
      case 'run-completed-success': {
        if (this.runOutcomeNotified) return null;
        this.runOutcomeNotified = true;
        const count = event.ticketCount ?? 0;
        return {
          title: 'Run completed',
          message: `${count} ticket(s) completed successfully.`,
          category: 'run-completed-success',
        };
      }
      case 'run-completed-with-issues': {
        if (this.runOutcomeNotified) return null;
        this.runOutcomeNotified = true;
        const failed = event.failedCount ?? 0;
        const blocked = event.blockedCount ?? 0;
        const total = event.ticketCount ?? 0;
        return {
          title: 'Run completed with issues',
          message: `${failed} failed, ${blocked} blocked out of ${total} ticket(s).`,
          category: 'run-completed-with-issues',
        };
      }
      default:
        return null;
    }
  }

  reset(): void {
    this.notifiedPermissions.clear();
    this.notifiedTickets.clear();
    this.runOutcomeNotified = false;
  }
}

/**
 * Classify an AFK {@link AgentExecutionProgressEvent} into a
 * {@link NotificationPolicyEvent} or `null` when the event is routine
 * progress that should not notify.
 */
export function classifyProgressEvent(event: AgentExecutionProgressEvent): NotificationPolicyEvent | null {
  if (event.kind === 'permission') {
    return {
      kind: 'permission-required',
      ticketLabel: event.ticketLabel,
      permissionKey: event.permissionId ? `${event.ticketLabel}:${event.permissionId}` : undefined,
      message: event.message,
    };
  }

  if (event.kind === 'failure') {
    return {
      kind: 'ticket-failed',
      ticketLabel: event.ticketLabel,
      message: event.message,
    };
  }

  return null;
}

/**
 * Summarise a set of ticket results into a single terminal-run
 * {@link NotificationPolicyEvent} or `null` when there is nothing to notify.
 */
export function classifyRunOutcome(options: {
  runId?: string;
  ticketResults: Array<{ ticketLabel: string; outcome: string }>;
}): NotificationPolicyEvent | null {
  const { runId, ticketResults } = options;
  const total = ticketResults.length;
  if (total === 0) return null;

  const failed = ticketResults.filter((r) => r.outcome === 'failed').length;
  const blocked = ticketResults.filter((r) => r.outcome === 'blocked' || r.outcome === 'not-scheduled').length;

  if (failed === 0 && blocked === 0) {
    return {
      kind: 'run-completed-success',
      runId,
      ticketCount: total,
    };
  }

  return {
    kind: 'run-completed-with-issues',
    runId,
    ticketCount: total,
    failedCount: failed,
    blockedCount: blocked,
  };
}
