import { readFileSync } from 'node:fs';
import { RuntimeStore } from './runtime-store.js';
import type { AgentExecutionProvider } from './agent-execution-provider.js';
import type { LaunchPlan, ReviewCycleHistoryEntry } from './types.js';
import { SummaryPresenceGate } from './summary-presence-gate.js';
import { decideReviewOutcome, parseReviewerOutput } from './reviewer-output-contract.js';

const MAX_REVIEW_CYCLES = 3;

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
    const reviewerPromptText = this.readReviewerPrompt(plan.reviewerPrompt.path);
    let prompt = `AFK run for ${ticket.label}`;
    let sessionId: string | null = null;
    let reviewCycle = 0;

    try {
      while (true) {
        const executionResult = await this.provider.execute({ plan, ticketIndex: 0, prompt, invocationMode: 'execution', sessionId });
        sessionId = executionResult.sessionId ?? sessionId;
        this.recordExecutionResult(record.metadataPath, record.logPath, executionResult, sessionId);
        if (executionResult.status !== 'completed') {
          this.runtimeStore.markFailed(record, executionResult.status);
          this.runtimeStore.appendLog(record.logPath, `run ${executionResult.status}`);
          return { scheduled: true, message: `Scheduled ${ticket.label}` };
        }

        const reviewResult = await this.provider.execute({
          plan,
          ticketIndex: 0,
          prompt: this.buildReviewerPrompt(ticket.label, reviewerPromptText, sessionId, executionResult),
          invocationMode: 'reviewer',
          sessionId,
        });
        this.runtimeStore.appendLog(record.logPath, `reviewer session: ${reviewResult.sessionId ?? 'unknown'}`);
        const review = parseReviewerOutput((reviewResult.output ?? []).join('\n'));
        const decision = decideReviewOutcome({ review, cycleCount: reviewCycle + 1, maxCycles: MAX_REVIEW_CYCLES });
        this.runtimeStore.recordReviewCycle(record.metadataPath, record.logPath, this.buildReviewCycleEntry(reviewCycle + 1, decision));

        if (decision.outcome === 'approve') {
          const ticketContent = this.readTicketContent(ticket.path);
          const terminalOutcome = this.summaryPresenceGate.hasSummary(ticketContent) ? 'approved' : 'needs-human';
          const terminalReason = terminalOutcome === 'approved' ? decision.reason : 'ready-for-human gate blocked: missing ## AFK Summary';
          this.runtimeStore.recordFinalReviewOutcome(record.metadataPath, record.logPath, {
            outcome: terminalOutcome,
            reason: terminalReason,
            cycle: reviewCycle + 1,
          });
          if (this.summaryPresenceGate.hasSummary(ticketContent)) {
            this.runtimeStore.markDone(record);
            this.runtimeStore.appendLog(record.logPath, 'run completed');
          } else {
            this.runtimeStore.appendLog(record.logPath, 'ready-for-human gate blocked: missing ## AFK Summary');
            this.runtimeStore.appendLog(record.logPath, 'run blocked: missing ## AFK Summary');
          }
          return { scheduled: true, message: `Scheduled ${ticket.label}` };
        }

        if (decision.outcome === 'handoff-required') {
          this.runtimeStore.updateMetadata(record.metadataPath, {
            STATUS: 'blocked',
            UNSAFE_REASON: decision.reason,
          });
          this.runtimeStore.recordFinalReviewOutcome(record.metadataPath, record.logPath, {
            outcome: 'needs-human',
            reason: decision.reason,
            cycle: reviewCycle + 1,
          });
          this.runtimeStore.markFailed(record, 'needs-human handoff required');
          this.runtimeStore.appendLog(record.logPath, `needs-human handoff: ${decision.reason}`);
          this.runtimeStore.appendLog(record.logPath, 'run blocked');
          return { scheduled: true, message: `Scheduled ${ticket.label}` };
        }

        reviewCycle += 1;
        prompt = this.buildFixupPrompt(ticket.label, sessionId, reviewCycle, review);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'provider execution failed';
      this.runtimeStore.updateMetadata(record.metadataPath, {
        STATUS: 'failed',
        UNSAFE_REASON: message,
      });
      this.runtimeStore.recordFinalReviewOutcome(record.metadataPath, record.logPath, {
        outcome: 'needs-human',
        reason: message,
        cycle: reviewCycle + 1,
      });
      this.runtimeStore.markFailed(record, 'failed');
      this.runtimeStore.appendLog(record.logPath, `run failed: ${message}`);
    }
    return { scheduled: true, message: `Scheduled ${ticket.label}` };
  }

  private readTicketContent(ticketPath: string): string {
    return readFileSync(ticketPath, 'utf8');
  }

  private readReviewerPrompt(promptPath: string): string {
    return readFileSync(promptPath, 'utf8');
  }

  private recordExecutionResult(metadataPath: string, logPath: string, result: { status: string; sessionId?: string | null; removable?: boolean; unsafeReason?: string | null; output?: string[]; inspectionTargetIdentifier?: string | null }, sessionId: string | null): void {
    this.runtimeStore.appendLog(logPath, `provider session: ${sessionId ?? 'unknown'}`);
    this.runtimeStore.updateMetadata(metadataPath, {
      STATUS: normalizeStatus(result.status),
      PROVIDER_SESSION_ID: sessionId,
      PROVIDER_SESSION_REMOVABLE: result.removable ?? false,
      UNSAFE_REASON: result.unsafeReason ?? null,
      INSPECTION_PROVIDER: result.inspectionTargetIdentifier ? 'tmux' : null,
      INSPECTION_TARGET_IDENTIFIER: result.inspectionTargetIdentifier ?? null,
    });
    (result.output ?? []).forEach((line) => this.runtimeStore.appendLog(logPath, line));
  }

  private buildReviewerPrompt(ticketLabel: string, reviewerPromptText: string, sessionId: string | null, executionResult: { status: string; output?: string[] }): string {
    return [
      reviewerPromptText.trim(),
      '',
      `Ticket: ${ticketLabel}`,
      `Execution session: ${sessionId ?? 'unknown'}`,
      `Execution status: ${executionResult.status}`,
      ...(executionResult.output?.length ? ['', 'Execution output:', ...executionResult.output] : []),
    ].join('\n');
  }

  private buildFixupPrompt(ticketLabel: string, sessionId: string | null, cycleCount: number, review: ReturnType<typeof parseReviewerOutput>): string {
    return [
      `AFK follow-up for ${ticketLabel}`,
      `Continue the same execution session: ${sessionId ?? 'unknown'}`,
      `Review cycle: ${cycleCount}`,
      `Reviewer summary: ${review.summary}`,
      'Reviewer findings:',
      ...review.findings.map((finding) => {
        const detail = finding.detail ? ` - ${finding.detail}` : '';
        const path = finding.path ? ` (${finding.path}${finding.line ? `:${finding.line}` : ''})` : '';
        return `- ${finding.severity}: ${finding.summary}${detail}${path}`;
      }),
    ].join('\n');
  }

  private buildReviewCycleEntry(cycle: number, decision: ReturnType<typeof decideReviewOutcome>): ReviewCycleHistoryEntry {
    return {
      cycle,
      outcome: decision.outcome,
      reason: decision.reason,
      malformed: decision.malformed,
      findings: decision.findings,
    };
  }
}

function normalizeStatus(status: string): 'completed' | 'failed' | 'interrupted' | 'blocked' | 'unknown' {
  if (status === 'completed' || status === 'failed' || status === 'interrupted' || status === 'blocked' || status === 'unknown') return status;
  return 'unknown';
}
