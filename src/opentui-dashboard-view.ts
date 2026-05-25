import type { NotificationPayload } from './notification-policy.js';
import type { NotificationDeliveryState, OpenTUIRenderer } from './opentui-notification-adapter.js';
import type { DashboardNotificationState, ProgressLine } from './progress-line.js';
import type { AgentExecutionProgressEvent } from './types.js';

export class OpenTUIDashboardView {
  private readonly notificationState: DashboardNotificationState;

  constructor(
    private readonly progressLine: ProgressLine,
    renderer: Pick<OpenTUIRenderer, 'capabilities'>,
  ) {
    this.notificationState = {
      capability: renderer.capabilities.notifications ? 'supported' : 'unsupported',
    };
    this.progressLine.updateNotificationState(this.notificationState);
  }

  getNotificationState(): DashboardNotificationState {
    return { ...this.notificationState };
  }

  updateProgress(event: AgentExecutionProgressEvent): void {
    this.progressLine.update(event);
  }

  recordDelivery(state: NotificationDeliveryState, payload?: NotificationPayload): void {
    this.notificationState.lastDelivery = { state, payload };
    this.progressLine.updateNotificationState(this.notificationState);
  }

  done(): void {
    this.progressLine.done();
  }
}
