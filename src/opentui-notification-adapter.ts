import type { NotificationPayload } from './notification-policy.js';

export type NotificationDeliveryState = 'sent' | 'unsupported' | 'skipped' | 'failed';

/**
 * Minimal subset of an OpenTUI renderer that the adapter needs to
 * check capabilities and trigger terminal notifications.
 */
export interface OpenTUIRenderer {
  capabilities: {
    notifications?: boolean;
  };
  notify?(title: string, message: string): void | Promise<void>;
}

/**
 * Best-effort adapter that bridges the notification policy payload to
 * the OpenTUI renderer notification API.
 *
 * - Returns `'skipped'` when the policy produced no payload.
 * - Returns `'unsupported'` when the renderer does not advertise
 *   notification capability.
 * - Returns `'failed'` when the renderer throws; the error is swallowed
 *   so AFK execution is never interrupted.
 * - Returns `'sent'` on success.
 */
export class OpenTUINotificationAdapter {
  constructor(private readonly renderer: OpenTUIRenderer) {}

  async maybeNotify(payload: NotificationPayload | null): Promise<NotificationDeliveryState> {
    if (!payload) {
      return 'skipped';
    }

    if (!this.renderer.capabilities.notifications || !this.renderer.notify) {
      return 'unsupported';
    }

    try {
      await this.renderer.notify(payload.title, payload.message);
      return 'sent';
    } catch {
      return 'failed';
    }
  }
}
