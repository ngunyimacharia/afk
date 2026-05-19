import { readFileSync } from 'node:fs';
import { RuntimeStore } from './runtime-store.js';
import type { AgentExecutionProvider } from './agent-execution-provider.js';
import type { AgentExecutionProgressCallback, LaunchBlockEvidence, LaunchPlan, ReviewerPromptTemplate, ReviewCycleHistoryEntry } from './types.js';
import { SummaryPresenceGate } from './summary-presence-gate.js';
import { buildPrompt } from './prompt-builder.js';
import { decideReviewOutcome, parseReviewerOutput } from './reviewer-output-contract.js';
import { classifyProviderFailure } from './provider-failure.js';
import { validateSelectedTicketPath } from './path-validation.js';

const MAX_REVIEW_CYCLES = 3;
const FIXUP_REMEDIATION_GUIDANCE = 'Remediation instructions: create one or more additional conventional fixup commits for the reviewer findings before the next review pass.';

export interface SingleTicketRunResult {
  scheduled: boolean;
  message: string;
  launchBlock?: LaunchBlockEvidence;
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
    const ticketPathValidation = validateSelectedTicketPath(plan.repoRoot, ticket);
    if (ticketPathValidation) return { scheduled: false, message: ticketPathValidation.message, launchBlock: ticketPathValidation };
    options.onProgress?.({ ticketLabel: ticket.label, message: 'starting ticket run' });
    const record = this.runtimeStore.createRecord({ featureSlug: ticket.feature, issueName: ticket.issueName, ticketPath: ticket.path });
    this.runtimeStore.appendLog(record.logPath, `ticket start: ${ticket.label}`);
    this.runtimeStore.appendLog(record.logPath, `model: ${plan.model.id}`);
    if (!plan.reviewerModel || !plan.reviewerPrompt) return this.launchWithoutReviewer(plan, record, options);

    this.runtimeStore.appendLog(record.logPath, `reviewer model: ${plan.reviewerModel.id}`);
    this.runtimeStore.appendLog(record.logPath, `reviewer prompt: ${plan.reviewerPrompt.id} (${plan.reviewerPrompt.path})`);
    this.runtimeStore.updateMetadata(record.metadataPath, {
      EXECUTION_MODEL_ID: plan.model.id,
      REVIEWER_MODEL_ID: plan.reviewerModel.id,
      REVIEWER_PROMPT_ID: plan.reviewerPrompt.id,
      REVIEWER_PROMPT_PATH: plan.reviewerPrompt.path,
    });
    const ticketContent = this.readTicketContent(ticket.path) ?? '';
    const reviewerPromptText = this.readReviewerPrompt(plan.reviewerPrompt);
    let prompt = buildPrompt({
      checkout: plan.checkout,
      ticket,
      ticketContent,
      reviewerPrompt: plan.reviewerPrompt,
      afkInstructions: this.readAfkInstructions(plan.repoRoot),
    });
    let sessionId: string | null = null;
    let reviewCycle = 0;

    try {
      while (true) {
        const executionResult = await this.provider.execute({ plan, ticketIndex: 0, prompt, invocationMode: 'execution', sessionId, onProgress: this.progressLogger(record.logPath, options.onProgress) });
        sessionId = executionResult.sessionId ?? sessionId;
        this.recordExecutionResult(record.metadataPath, record.logPath, executionResult, sessionId);
        if (executionResult.status !== 'completed') {
          this.runtimeStore.markFailed(record, executionResult.status);
          this.runtimeStore.appendLog(record.logPath, `run ${executionResult.status}`);
          options.onProgress?.({ ticketLabel: ticket.label, message: `run ${executionResult.status}`, sessionId });
          return { scheduled: true, message: `Scheduled ${ticket.label}` };
        }

        const reviewResult = await this.provider.execute({
          plan,
          ticketIndex: 0,
          prompt: this.buildReviewerPrompt(ticket.label, reviewerPromptText, sessionId, executionResult),
          invocationMode: 'reviewer',
          sessionId,
          onProgress: this.progressLogger(record.logPath, options.onProgress),
        });
        this.runtimeStore.appendLog(record.logPath, `reviewer session: ${reviewResult.sessionId ?? 'unknown'}`);
        const review = parseReviewerOutput((reviewResult.output ?? []).join('\n'));
        const decision = decideReviewOutcome(review, { cycle: reviewCycle + 1, maxCycles: MAX_REVIEW_CYCLES });
        this.runtimeStore.recordReviewCycle(record.metadataPath, record.logPath, this.buildReviewCycleEntry(reviewCycle + 1, decision));

        if (decision.decision === 'approve') {
          const ticketContent = this.readTicketContent(ticket.path);
          const terminalOutcome = this.summaryPresenceGate.hasSummary(ticketContent ?? '') ? 'approved' : 'needs-human';
          const terminalReason = terminalOutcome === 'approved' ? decision.reason : 'ready-for-human gate blocked: missing ## AFK Summary';
          this.runtimeStore.recordFinalReviewOutcome(record.metadataPath, record.logPath, {
            outcome: terminalOutcome,
            reason: terminalReason,
            cycle: reviewCycle + 1,
          });
          if (this.summaryPresenceGate.hasSummary(ticketContent ?? '')) {
            this.runtimeStore.markDone(record);
            this.runtimeStore.appendLog(record.logPath, 'run completed');
            options.onProgress?.({ ticketLabel: ticket.label, message: 'run completed', sessionId });
          } else {
            this.runtimeStore.appendLog(record.logPath, 'ready-for-human gate blocked: missing ## AFK Summary');
            this.runtimeStore.appendLog(record.logPath, 'run blocked: missing ## AFK Summary');
            options.onProgress?.({ ticketLabel: ticket.label, message: 'run blocked: missing ## AFK Summary', sessionId });
          }
          return { scheduled: true, message: `Scheduled ${ticket.label}` };
        }

        if (decision.decision === 'needs-human') {
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
          options.onProgress?.({ ticketLabel: ticket.label, message: 'run blocked', sessionId });
          return { scheduled: true, message: `Scheduled ${ticket.label}` };
        }

        reviewCycle += 1;
        prompt = this.buildFixupPrompt(ticket.label, sessionId, reviewCycle, review);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'provider execution failed';
      options.onProgress?.({ ticketLabel: ticket.label, message: `run failed: ${message}` });
      this.runtimeStore.updateMetadata(record.metadataPath, {
        STATUS: 'failed',
        UNSAFE_REASON: message,
        FAILURE_KIND: classifyProviderFailure(message)?.kind ?? 'unknown',
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

  private readReviewerPrompt(prompt: ReviewerPromptTemplate): string {
    return prompt.content ?? readFileSync(prompt.path, 'utf8');
  }

  private async launchWithoutReviewer(plan: LaunchPlan, record: { metadataPath: string; logPath: string; doneSentinelPath: string; failedSentinelPath: string }, options: { onProgress?: AgentExecutionProgressCallback }): Promise<SingleTicketRunResult> {
    const ticket = plan.tickets[0];
    if (!ticket) return { scheduled: false, message: 'No ticket available for launch' };
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
      const result = await this.provider.execute({ plan, ticketIndex: 0, prompt, onProgress: this.progressLogger(record.logPath, options.onProgress) });
      this.recordExecutionResult(record.metadataPath, record.logPath, result, result.sessionId ?? null);
      if (result.status === 'completed') {
        const updatedTicketContent = this.readTicketContent(ticket.path) ?? '';
        if (this.summaryPresenceGate.hasSummary(updatedTicketContent)) {
          this.runtimeStore.markDone(record);
          this.runtimeStore.appendLog(record.logPath, 'run completed');
        } else {
          this.runtimeStore.appendLog(record.logPath, 'ready-for-human gate blocked: missing ## AFK Summary');
        }
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
        FAILURE_KIND: classifyProviderFailure(message)?.kind ?? 'unknown',
      });
      this.runtimeStore.markFailed(record, 'failed');
      this.runtimeStore.appendLog(record.logPath, `run failed: ${message}`);
    }

    return { scheduled: true, message: `Scheduled ${ticket.label}` };
  }

  private progressLogger(logPath: string, onProgress: AgentExecutionProgressCallback | undefined): AgentExecutionProgressCallback {
    return (event) => {
      if (event.kind === 'permission') this.runtimeStore.appendLog(logPath, `permission required: ${event.message}`);
      else if (event.kind === 'failure') this.runtimeStore.appendLog(logPath, event.message);
      else if (event.permissionId) this.runtimeStore.appendLog(logPath, `permission event: ${event.message}`);
      onProgress?.(event);
    };
  }

  private recordExecutionResult(metadataPath: string, logPath: string, result: { status: string; sessionId?: string | null; removable?: boolean; unsafeReason?: string | null; output?: string[]; inspectionTargetIdentifier?: string | null }, sessionId: string | null): void {
    this.runtimeStore.appendLog(logPath, `provider session: ${sessionId ?? 'unknown'}`);
    this.runtimeStore.updateMetadata(metadataPath, {
      STATUS: normalizeStatus(result.status),
      PROVIDER_SESSION_ID: sessionId,
      PROVIDER_SESSION_REMOVABLE: result.removable ?? false,
      UNSAFE_REASON: result.unsafeReason ?? null,
      FAILURE_KIND: result.status === 'completed' ? null : classifyProviderFailure(result.unsafeReason ?? (result.output ?? []).join('\n'))?.kind ?? 'unknown',
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
      FIXUP_REMEDIATION_GUIDANCE,
      `Reviewer summary: ${review.summary}`,
      'Reviewer findings:',
      ...review.findings.map((finding) => {
        const detail = finding.detail ? ` - ${finding.detail}` : '';
        return `- ${finding.severity}: ${finding.title}${detail}`;
      }),
    ].join('\n');
  }

  private buildReviewCycleEntry(cycle: number, decision: ReturnType<typeof decideReviewOutcome>): ReviewCycleHistoryEntry {
    return {
      cycle,
      outcome: decision.decision === 'approve' ? 'approve' : decision.decision === 'needs-human' ? 'handoff-required' : 'loop-required',
      reason: decision.reason,
      malformed: decision.fallback,
      findings: decision.findings.map((finding) => ({ severity: finding.severity, summary: finding.title, detail: finding.detail })),
    };
  }
}

function normalizeStatus(status: string): 'completed' | 'failed' | 'interrupted' | 'blocked' | 'unknown' {
  if (status === 'completed' || status === 'failed' || status === 'interrupted' || status === 'blocked' || status === 'unknown') return status;
  return 'unknown';
}
