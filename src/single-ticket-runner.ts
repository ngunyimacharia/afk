import { readFileSync } from 'node:fs';
import { RuntimeStore } from './runtime-store.js';
import type { AgentExecutionProvider } from './agent-execution-provider.js';
import type { AgentExecutionProgressCallback, LaunchPlan, ReviewerPromptTemplate, ReviewCycleHistoryEntry, ReviewOutcomeClassification, ReviewTerminalOutcomeRecord } from './types.js';
import { SummaryPresenceGate } from './summary-presence-gate.js';
import { buildPrompt } from './prompt-builder.js';
import { decideReviewOutcome, parseReviewerOutput } from './reviewer-output-contract.js';
import { classifyProviderFailure } from './provider-failure.js';

const MAX_REVIEW_CYCLES = 3;
const MAX_MALFORMED_REVIEW_ATTEMPTS = 2;
const FIXUP_REMEDIATION_GUIDANCE = 'Remediation instructions: create one or more additional conventional fixup commits for the reviewer findings before the next review pass.';
const REVIEWER_OUTPUT_MALFORMED_FAILURE_KIND = 'reviewer-output-malformed';
const REVIEWER_FORMAT_REPAIR_INSTRUCTIONS = [
  'The previous reviewer response was malformed.',
  'Return JSON only with this exact shape: {"summary":"string","findings":[{"severity":"minor|major|blocker","title":"string","detail":"string"}]}.',
  'Do not include markdown fences, commentary, or extra fields.',
].join(' ');
const MAX_MALFORMED_OUTPUT_SNIPPET_CHARS = 500;

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
    let malformedReviewAttempts = 0;
    let retryReviewerOnly = false;
    let useReviewerRepairPrompt = false;
    let lastExecutionResult: { status: string; output?: string[] } | null = null;

    try {
      while (true) {
        let executionResult = lastExecutionResult;
        if (!retryReviewerOnly || !executionResult) {
          const executionInvocationResult = await this.provider.execute({ plan, ticketIndex: 0, prompt, invocationMode: 'execution', sessionId, onProgress: this.progressLogger(record.logPath, options.onProgress) });
          sessionId = executionInvocationResult.sessionId ?? sessionId;
          this.recordExecutionResult(record.metadataPath, record.logPath, executionInvocationResult, sessionId);
          if (executionInvocationResult.status !== 'completed') {
            this.runtimeStore.markFailed(record, executionInvocationResult.status);
            this.runtimeStore.appendLog(record.logPath, `run ${executionInvocationResult.status}`);
            options.onProgress?.({ ticketLabel: ticket.label, message: `run ${executionInvocationResult.status}`, sessionId });
            return { scheduled: true, message: `Scheduled ${ticket.label}` };
          }
          executionResult = executionInvocationResult;
          lastExecutionResult = executionInvocationResult;
        }

        retryReviewerOnly = false;

        const reviewResult = await this.provider.execute({
          plan,
          ticketIndex: 0,
          prompt: useReviewerRepairPrompt
            ? this.buildReviewerRepairPrompt(ticket.label, reviewerPromptText, sessionId, executionResult)
            : this.buildReviewerPrompt(ticket.label, reviewerPromptText, sessionId, executionResult),
          invocationMode: 'reviewer',
          sessionId,
          onProgress: this.progressLogger(record.logPath, options.onProgress),
        });
        useReviewerRepairPrompt = false;
        this.runtimeStore.appendLog(record.logPath, `reviewer session: ${reviewResult.sessionId ?? 'unknown'}`);
        const review = parseReviewerOutput((reviewResult.output ?? []).join('\n'));
        if (review.fallback) {
          malformedReviewAttempts += 1;
          if (malformedReviewAttempts < MAX_MALFORMED_REVIEW_ATTEMPTS) {
            const malformedRetryMessage = `malformed reviewer output retry ${malformedReviewAttempts}/${MAX_MALFORMED_REVIEW_ATTEMPTS - 1}`;
            this.runtimeStore.appendLog(record.logPath, malformedRetryMessage);
            options.onProgress?.({ ticketLabel: ticket.label, message: malformedRetryMessage, sessionId });
            retryReviewerOnly = true;
            useReviewerRepairPrompt = true;
            continue;
          }

          const malformedHandoffReason = 'Malformed reviewer output repeated after format-repair retry';
          const malformedOutputSnippet = this.boundSnippet(review.raw);
          this.runtimeStore.updateMetadata(record.metadataPath, {
            STATUS: 'blocked',
            UNSAFE_REASON: malformedHandoffReason,
            FAILURE_KIND: REVIEWER_OUTPUT_MALFORMED_FAILURE_KIND,
          });
          this.runtimeStore.recordReviewCycle(record.metadataPath, record.logPath, {
            cycle: reviewCycle + 1,
            outcome: 'handoff-required',
            reason: malformedHandoffReason,
            malformed: true,
            findings: [],
            classification: 'malformed-output-handoff',
            malformedOutputSnippet,
          });
          this.runtimeStore.recordFinalReviewOutcome(record.metadataPath, record.logPath, this.buildFinalOutcomeRecord({
            cycle: reviewCycle + 1,
            outcome: 'needs-human',
            reason: malformedHandoffReason,
            classification: 'malformed-output-handoff',
            malformed: true,
            findings: [],
            malformedOutputSnippet,
          }));
          this.runtimeStore.markFailed(record, 'needs-human handoff required');
          this.runtimeStore.appendLog(record.logPath, 'malformed reviewer output handoff: reviewer-output-malformed');
          this.runtimeStore.appendLog(record.logPath, 'run blocked');
          options.onProgress?.({ ticketLabel: ticket.label, message: 'malformed reviewer output handoff', sessionId });
          return { scheduled: true, message: `Scheduled ${ticket.label}` };
        }

        malformedReviewAttempts = 0;
        const decision = decideReviewOutcome(review, { cycle: reviewCycle + 1, maxCycles: MAX_REVIEW_CYCLES });
        this.runtimeStore.recordReviewCycle(record.metadataPath, record.logPath, this.buildReviewCycleEntry(reviewCycle + 1, decision));

        if (decision.decision === 'approve') {
          const ticketContent = this.readTicketContent(ticket.path);
          const terminalOutcome = this.summaryPresenceGate.hasSummary(ticketContent ?? '') ? 'approved' : 'needs-human';
          const terminalReason = terminalOutcome === 'approved' ? decision.reason : 'ready-for-human gate blocked: missing ## AFK Summary';
          const classification: ReviewOutcomeClassification = review.findings.length === 0 ? 'clean-approval' : 'minor-risk-approval';
          this.runtimeStore.recordFinalReviewOutcome(record.metadataPath, record.logPath, this.buildFinalOutcomeRecord({
            cycle: reviewCycle + 1,
            outcome: terminalOutcome,
            reason: terminalReason,
            classification,
            malformed: false,
            findings: review.findings.map((finding) => ({ severity: finding.severity, summary: finding.title, detail: finding.detail })),
          }));
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
            classification: 'real-finding-handoff',
            malformed: false,
            findings: decision.findings.map((finding) => ({ severity: finding.severity, summary: finding.title, detail: finding.detail })),
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

  private buildReviewerRepairPrompt(ticketLabel: string, reviewerPromptText: string, sessionId: string | null, executionResult: { status: string; output?: string[] }): string {
    return [
      this.buildReviewerPrompt(ticketLabel, reviewerPromptText, sessionId, executionResult),
      '',
      REVIEWER_FORMAT_REPAIR_INSTRUCTIONS,
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
    const hasRealFindings = decision.findings.some((finding) => finding.severity === 'major' || finding.severity === 'blocker');
    return {
      cycle,
      outcome: decision.decision === 'approve' ? 'approve' : decision.decision === 'needs-human' ? 'handoff-required' : 'loop-required',
      reason: decision.reason,
      malformed: decision.fallback,
      findings: decision.findings.map((finding) => ({ severity: finding.severity, summary: finding.title, detail: finding.detail })),
      classification: decision.decision === 'approve'
        ? (decision.findings.length === 0 ? 'clean-approval' : 'minor-risk-approval')
        : hasRealFindings
          ? (decision.decision === 'needs-human' ? 'real-finding-handoff' : 'real-finding-loop')
          : undefined,
    };
  }

  private buildFinalOutcomeRecord(outcome: ReviewTerminalOutcomeRecord): ReviewTerminalOutcomeRecord {
    return {
      ...outcome,
      malformedOutputSnippet: outcome.malformedOutputSnippet ? this.boundSnippet(outcome.malformedOutputSnippet) : outcome.malformedOutputSnippet,
    };
  }

  private boundSnippet(raw: string): string {
    return raw.slice(0, MAX_MALFORMED_OUTPUT_SNIPPET_CHARS);
  }
}

function normalizeStatus(status: string): 'completed' | 'failed' | 'interrupted' | 'blocked' | 'unknown' {
  if (status === 'completed' || status === 'failed' || status === 'interrupted' || status === 'blocked' || status === 'unknown') return status;
  return 'unknown';
}
