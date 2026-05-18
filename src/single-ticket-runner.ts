import { readFileSync } from 'node:fs';
import { RuntimeStore } from './runtime-store.js';
import type { AgentExecutionProvider } from './agent-execution-provider.js';
import type { LaunchPlan } from './types.js';
import { SummaryPresenceGate } from './summary-presence-gate.js';

export interface SingleTicketRunResult {
  scheduled: boolean;
  message: string;
}

export class SingleTicketRunner {
  constructor(
    private readonly runtimeStore: RuntimeStore,
    private readonly provider: AgentExecutionProvider,
    private readonly summaryPresenceGate = new SummaryPresenceGate(),
  ) {}

  async launch(plan: LaunchPlan): Promise<SingleTicketRunResult> {
    const ticket = plan.tickets[0];
    if (!ticket) return { scheduled: false, message: 'No ticket available for launch' };
    const record = this.runtimeStore.createRecord({ featureSlug: ticket.feature, issueName: ticket.issueName, ticketPath: ticket.path });
    this.runtimeStore.appendLog(record.logPath, `ticket start: ${ticket.label}`);
    this.runtimeStore.appendLog(record.logPath, `model: ${plan.model.id}`);
    this.runtimeStore.appendLog(record.logPath, `reviewer model: ${plan.reviewerModel.id}`);
    this.runtimeStore.appendLog(record.logPath, `reviewer prompt: ${plan.reviewerPrompt.id} -> ${plan.reviewerPrompt.path}`);
    this.runtimeStore.updateMetadata(record.metadataPath, {
      EXECUTION_MODEL_ID: plan.model.id,
      REVIEWER_MODEL_ID: plan.reviewerModel.id,
      REVIEWER_PROMPT_ID: plan.reviewerPrompt.id,
      REVIEWER_PROMPT_PATH: plan.reviewerPrompt.path,
    });
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
      if (result.status === 'completed') {
        const ticketContent = this.readTicketContent(ticket.path);
        if (this.summaryPresenceGate.hasSummary(ticketContent)) this.runtimeStore.markDone(record);
        else this.runtimeStore.appendLog(record.logPath, 'ready-for-human gate blocked: missing ## AFK Summary');
      } else {
        this.runtimeStore.markFailed(record, result.status);
      }
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

  private readTicketContent(ticketPath: string): string {
    return readFileSync(ticketPath, 'utf8');
  }
}

function normalizeStatus(status: string): 'completed' | 'failed' | 'interrupted' | 'blocked' | 'unknown' {
  if (status === 'completed' || status === 'failed' || status === 'interrupted' || status === 'blocked' || status === 'unknown') return status;
  return 'unknown';
}
