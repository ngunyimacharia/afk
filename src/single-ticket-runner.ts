import { readFileSync } from 'node:fs';
import { RuntimeStore } from './runtime-store.js';
import type { AgentExecutionProvider } from './agent-execution-provider.js';
import type { AgentExecutionProgressCallback, LaunchPlan } from './types.js';
import { SummaryPresenceGate } from './summary-presence-gate.js';
import { buildPrompt } from './prompt-builder.js';

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

  async launch(plan: LaunchPlan, options: { onProgress?: AgentExecutionProgressCallback } = {}): Promise<SingleTicketRunResult> {
    const ticket = plan.tickets[0];
    if (!ticket) return { scheduled: false, message: 'No ticket available for launch' };
    options.onProgress?.({ ticketLabel: ticket.label, message: 'starting ticket run' });
    const record = this.runtimeStore.createRecord({ featureSlug: ticket.feature, issueName: ticket.issueName, ticketPath: ticket.path });
    this.runtimeStore.appendLog(record.logPath, `ticket start: ${ticket.label}`);
    this.runtimeStore.appendLog(record.logPath, `model: ${plan.model.id}`);
    if (plan.reviewerModel) this.runtimeStore.appendLog(record.logPath, `reviewer model: ${plan.reviewerModel.id}`);
    if (plan.reviewerPrompt) this.runtimeStore.appendLog(record.logPath, `reviewer prompt: ${plan.reviewerPrompt.id} (${plan.reviewerPrompt.path})`);
    const ticketContent = this.readTicketContent(ticket.path) ?? '';
    const prompt = buildPrompt({
      checkout: plan.checkout,
      ticket,
      ticketContent,
      reviewerPrompt: plan.reviewerPrompt,
      afkInstructions: this.readAfkInstructions(plan.repoRoot),
    });

    try {
      const result = await this.provider.execute({ plan, ticketIndex: 0, prompt, onProgress: options.onProgress });
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
        const updatedTicketContent = this.readTicketContent(ticket.path) ?? '';
        if (this.summaryPresenceGate.hasSummary(updatedTicketContent)) this.runtimeStore.markDone(record);
        else this.runtimeStore.appendLog(record.logPath, 'ready-for-human gate blocked: missing ## AFK Summary');
      } else {
        this.runtimeStore.markFailed(record, result.status);
      }
      this.runtimeStore.appendLog(record.logPath, `run ${result.status}`);
      options.onProgress?.({ ticketLabel: ticket.label, message: `run ${result.status}`, sessionId: result.sessionId ?? null });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'provider execution failed';
      options.onProgress?.({ ticketLabel: ticket.label, message: `run failed: ${message}` });
      this.runtimeStore.updateMetadata(record.metadataPath, {
        STATUS: 'failed',
        UNSAFE_REASON: message,
      });
      this.runtimeStore.markFailed(record, 'failed');
      this.runtimeStore.appendLog(record.logPath, `run failed: ${message}`);
    }
    return { scheduled: true, message: `Scheduled ${ticket.label}` };
  }

  private readTicketContent(ticketPath: string): string | null {
    try {
      return readFileSync(ticketPath, 'utf8');
    } catch {
      return null;
    }
  }

  private readAfkInstructions(repoRoot: string): string | undefined {
    try {
      return readFileSync(`${repoRoot}/src/prompts/afk-prompt.md`, 'utf8');
    } catch {
      return undefined;
    }
  }
}

function normalizeStatus(status: string): 'completed' | 'failed' | 'interrupted' | 'blocked' | 'unknown' {
  if (status === 'completed' || status === 'failed' || status === 'interrupted' || status === 'blocked' || status === 'unknown') return status;
  return 'unknown';
}
