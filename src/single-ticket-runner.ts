import { RuntimeStore } from './runtime-store.js';
import type { AgentExecutionProvider } from './agent-execution-provider.js';
import type { LaunchPlan } from './types.js';

export interface SingleTicketRunResult {
  scheduled: boolean;
  message: string;
}

export class SingleTicketRunner {
  constructor(private readonly runtimeStore: RuntimeStore, private readonly provider: AgentExecutionProvider) {}

  async launch(plan: LaunchPlan): Promise<SingleTicketRunResult> {
    const ticket = plan.tickets[0];
    if (!ticket) return { scheduled: false, message: 'No ticket available for launch' };
    const record = this.runtimeStore.createRecord({ featureSlug: ticket.feature, issueName: ticket.issueName, ticketPath: ticket.path });
    this.runtimeStore.appendLog(record.logPath, `ticket start: ${ticket.label}`);
    this.runtimeStore.appendLog(record.logPath, `model: ${plan.model.id}`);
    const prompt = `AFK run for ${ticket.label}`;

    try {
      const result = await this.provider.execute({ plan, ticketIndex: 0, prompt });
      this.runtimeStore.appendLog(record.logPath, `provider session: ${result.sessionId ?? 'unknown'}`);
      this.runtimeStore.updateMetadata(record.metadataPath, {
        STATUS: normalizeStatus(result.status),
        PROVIDER_SESSION_ID: result.sessionId ?? null,
        PROVIDER_SESSION_REMOVABLE: result.removable ?? false,
        UNSAFE_REASON: result.unsafeReason ?? null,
        INSPECTION_PROVIDER: result.inspectionTargetIdentifier ? 'tmux' : null,
        INSPECTION_TARGET_IDENTIFIER: result.inspectionTargetIdentifier ?? null,
      });
      (result.output ?? []).forEach((line) => this.runtimeStore.appendLog(record.logPath, line));
      if (result.status === 'completed') this.runtimeStore.markDone(record);
      else this.runtimeStore.markFailed(record, result.status);
      this.runtimeStore.appendLog(record.logPath, `run ${result.status}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'provider execution failed';
      this.runtimeStore.updateMetadata(record.metadataPath, {
        STATUS: 'failed',
        UNSAFE_REASON: message,
      });
      this.runtimeStore.markFailed(record, 'failed');
      this.runtimeStore.appendLog(record.logPath, `run failed: ${message}`);
    }
    return { scheduled: true, message: `Scheduled ${ticket.label}` };
  }
}

function normalizeStatus(status: string): 'completed' | 'failed' | 'interrupted' | 'blocked' | 'unknown' {
  if (status === 'completed' || status === 'failed' || status === 'interrupted' || status === 'blocked' || status === 'unknown') return status;
  return 'unknown';
}
