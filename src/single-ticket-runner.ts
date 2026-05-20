import { readFileSync } from 'node:fs';
import { RuntimeStore } from './runtime-store.js';
import type { AgentExecutionProvider } from './agent-execution-provider.js';
import type { AgentExecutionProgressCallback, AgentExecutionResult, BudgetExceededEvent, BudgetPhaseName, BudgetPolicy, LaunchPlan, ReviewerPromptTemplate, ReviewCycleHistoryEntry } from './types.js';
import { SummaryPresenceGate } from './summary-presence-gate.js';
import { buildPrompt } from './prompt-builder.js';
import { decideReviewOutcome, parseReviewerOutput } from './reviewer-output-contract.js';
import { classifyProviderFailure } from './provider-failure.js';

const FIXUP_REMEDIATION_GUIDANCE = 'Remediation instructions: create one or more additional conventional fixup commits for the reviewer findings before the next review pass.';
const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
  malformedReviewerRetries: 1,
  fixupCycleLimit: 3,
  providerFailureRetries: 0,
};

export interface SingleTicketRunResult {
  scheduled: boolean;
  message: string;
}

export class SingleTicketRunner {
  constructor(
    private readonly runtimeStore: RuntimeStore,
    private readonly provider: AgentExecutionProvider,
    private readonly summaryPresenceGate = new SummaryPresenceGate(),
    private readonly configuredBudgets: Partial<BudgetPolicy> = {},
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
    const budgets = this.resolveBudgets();
    this.runtimeStore.updateMetadata(record.metadataPath, { EFFECTIVE_BUDGETS: budgets });
    this.runtimeStore.appendLog(record.logPath, `effective budgets: ${JSON.stringify(budgets)}`);
    let prompt = buildPrompt({
      checkout: plan.checkout,
      ticket,
      ticketContent,
      reviewerPrompt: plan.reviewerPrompt,
      afkInstructions: this.readAfkInstructions(plan.repoRoot),
    });
    this.runtimeStore.completePhase(record.metadataPath, record.logPath, this.runtimeStore.startPhase('launch-preparation'));
    this.runtimeStore.completePhase(record.metadataPath, record.logPath, this.runtimeStore.startPhase('worktree-preparation'));
    this.runtimeStore.completePhase(record.metadataPath, record.logPath, this.runtimeStore.startPhase('readiness'));
    let sessionId: string | null = null;
    let reviewCycle = 0;
    let fixupCycles = 0;
    let malformedAttempts = 0;
    let latestExecutionResult: AgentExecutionResult | null = null;
    let executeBeforeReview = true;
    const ticketStartEpoch = Date.now();

    try {
      while (true) {
        const ticketBudget = this.checkTicketBudget(record.metadataPath, record.logPath, budgets, ticketStartEpoch, reviewCycle + 1);
        if (ticketBudget) return this.handoffForBudget(ticket.label, record, options, ticketBudget, sessionId);
        if (executeBeforeReview && fixupCycles >= budgets.fixupCycleLimit && reviewCycle > 0) {
          return this.handoffForBudget(ticket.label, record, options, {
            budgetName: 'fixup-cycle-cap',
            limit: budgets.fixupCycleLimit,
            observed: fixupCycles,
            phase: 'fixup',
            cycle: reviewCycle,
            evidence: 'Real implementation fixup cycle cap reached',
          }, sessionId);
        }
        if (executeBeforeReview) {
          const executionResult = await this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'execution', () => this.provider.execute({
            plan,
            ticketIndex: 0,
            prompt,
            invocationMode: 'execution',
            sessionId,
            onProgress: this.progressLogger(record.logPath, options.onProgress),
          }), reviewCycle + 1);
          sessionId = executionResult.sessionId ?? sessionId;
          latestExecutionResult = executionResult;
          this.recordExecutionResult(record.metadataPath, record.logPath, executionResult, sessionId);
          const executionBudget = this.checkPhaseBudget(record.metadataPath, record.logPath, budgets, 'execution', reviewCycle + 1);
          if (executionBudget) return this.handoffForBudget(ticket.label, record, options, executionBudget, sessionId);
          if (executionResult.status !== 'completed') {
            return this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'finalization', () => {
              this.runtimeStore.markFailed(record, executionResult.status);
              this.runtimeStore.appendLog(record.logPath, `run ${executionResult.status}`);
              options.onProgress?.({ ticketLabel: ticket.label, message: `run ${executionResult.status}`, sessionId });
              return { scheduled: true, message: `Scheduled ${ticket.label}` };
            });
          }
        }
        if (!latestExecutionResult) return { scheduled: false, message: 'No execution result available for review' };
        const executionForReview = latestExecutionResult;

        const reviewResult = await this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'review', () => this.provider.execute({
          plan,
          ticketIndex: 0,
          prompt: this.buildReviewerPrompt(ticket.label, reviewerPromptText, sessionId, executionForReview),
          invocationMode: 'reviewer',
          sessionId,
          onProgress: this.progressLogger(record.logPath, options.onProgress),
        }), reviewCycle + 1);
        const reviewBudget = this.checkPhaseBudget(record.metadataPath, record.logPath, budgets, 'review', reviewCycle + 1);
        if (reviewBudget) return this.handoffForBudget(ticket.label, record, options, reviewBudget, sessionId);
        const afterReviewTicketBudget = this.checkTicketBudget(record.metadataPath, record.logPath, budgets, ticketStartEpoch, reviewCycle + 1);
        if (afterReviewTicketBudget) return this.handoffForBudget(ticket.label, record, options, afterReviewTicketBudget, sessionId);
        this.runtimeStore.appendLog(record.logPath, `reviewer session: ${reviewResult.sessionId ?? 'unknown'}`);
        const review = parseReviewerOutput((reviewResult.output ?? []).join('\n'));
        const decision = decideReviewOutcome(review, { cycle: reviewCycle + 1, maxCycles: budgets.fixupCycleLimit + 1 });
        this.runtimeStore.recordReviewCycle(record.metadataPath, record.logPath, this.buildReviewCycleEntry(reviewCycle + 1, decision));

        if (decision.decision === 'approve') {
          return this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'finalization', () => {
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
          });
        }

        if (decision.fallback) {
          malformedAttempts += 1;
          if (malformedAttempts > budgets.malformedReviewerRetries) {
            return this.handoffForBudget(ticket.label, record, options, {
              budgetName: 'malformed-reviewer-retries',
              limit: budgets.malformedReviewerRetries,
              observed: malformedAttempts,
              phase: 'review',
              cycle: reviewCycle + 1,
              evidence: decision.reason,
            }, sessionId);
          }
          executeBeforeReview = false;
          continue;
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
          return this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'finalization', () => {
            this.runtimeStore.markFailed(record, 'needs-human handoff required');
            this.runtimeStore.appendLog(record.logPath, `needs-human handoff: ${decision.reason}`);
            this.runtimeStore.appendLog(record.logPath, 'run blocked');
            options.onProgress?.({ ticketLabel: ticket.label, message: 'run blocked', sessionId });
            return { scheduled: true, message: `Scheduled ${ticket.label}` };
          });
        }

        reviewCycle += 1;
        fixupCycles += 1;
        prompt = await this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'fixup', () => this.buildFixupPrompt(ticket.label, sessionId, reviewCycle, review), reviewCycle);
        const fixupBudget = this.checkPhaseBudget(record.metadataPath, record.logPath, budgets, 'fixup', reviewCycle);
        if (fixupBudget) return this.handoffForBudget(ticket.label, record, options, fixupBudget, sessionId);
        executeBeforeReview = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'provider execution failed';
      this.runtimeStore.appendLog(record.logPath, `provider failure retries configured: ${budgets.providerFailureRetries}; retries not attempted for implementation by policy`);
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

  private resolveBudgets(): BudgetPolicy {
    return {
      ...DEFAULT_BUDGET_POLICY,
      ...this.configuredBudgets,
    };
  }

  private checkTicketBudget(metadataPath: string, logPath: string, budgets: BudgetPolicy, ticketStartEpoch: number, cycle: number): BudgetExceededEvent | null {
    const limit = budgets.ticketWallClockMs;
    if (!limit) return null;
    const observed = Date.now() - ticketStartEpoch;
    if (observed <= limit) return null;
    const event: BudgetExceededEvent = {
      budgetName: 'ticket-wall-clock-ms',
      limit,
      observed,
      phase: 'ticket',
      cycle,
      evidence: `Ticket runtime exceeded wall-clock budget (${observed}ms > ${limit}ms)`,
    };
    return event;
  }

  private checkPhaseBudget(metadataPath: string, logPath: string, budgets: BudgetPolicy, phase: BudgetPhaseName, cycle: number): BudgetExceededEvent | null {
    const limit = budgets.phaseWallClockMs?.[phase];
    if (!limit) return null;
    const metadata = this.runtimeStore.readMetadata(metadataPath);
    const latest = [...(metadata.PHASE_HISTORY ?? [])].reverse().find((entry) => entry.name === phase && entry.cycle === cycle);
    if (!latest || latest.durationMs <= limit) return null;
    const event: BudgetExceededEvent = {
      budgetName: `phase-${phase}-wall-clock-ms`,
      limit,
      observed: latest.durationMs,
      phase,
      cycle,
      evidence: `Phase ${phase} exceeded wall-clock budget (${latest.durationMs}ms > ${limit}ms)`,
    };
    return event;
  }

  private handoffForBudget(
    ticketLabel: string,
    record: { metadataPath: string; logPath: string; doneSentinelPath: string; failedSentinelPath: string },
    options: { onProgress?: AgentExecutionProgressCallback },
    event: BudgetExceededEvent,
    sessionId: string | null,
  ): Promise<SingleTicketRunResult> {
    this.runtimeStore.recordBudgetExceeded(record.metadataPath, record.logPath, event);
    const reason = `budget exceeded: ${event.budgetName} (limit=${event.limit}, observed=${event.observed}, phase=${event.phase}, cycle=${event.cycle})`;
    this.runtimeStore.updateMetadata(record.metadataPath, {
      STATUS: 'blocked',
      UNSAFE_REASON: reason,
      FAILURE_KIND: 'needs-human',
    });
    this.runtimeStore.recordFinalReviewOutcome(record.metadataPath, record.logPath, {
      outcome: 'needs-human',
      reason,
      cycle: event.cycle,
    });
    return this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'finalization', () => {
      this.runtimeStore.markFailed(record, reason);
      this.runtimeStore.appendLog(record.logPath, `needs-human handoff: ${reason}`);
      this.runtimeStore.appendLog(record.logPath, 'run blocked');
      options.onProgress?.({ ticketLabel, message: `budget handoff: ${reason}`, sessionId });
      return { scheduled: true, message: `Scheduled ${ticketLabel}` };
    });
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
    this.runtimeStore.completePhase(record.metadataPath, record.logPath, this.runtimeStore.startPhase('launch-preparation'));
    this.runtimeStore.completePhase(record.metadataPath, record.logPath, this.runtimeStore.startPhase('worktree-preparation'));
    this.runtimeStore.completePhase(record.metadataPath, record.logPath, this.runtimeStore.startPhase('readiness'));

    try {
      const result = await this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'execution', () => this.provider.execute({ plan, ticketIndex: 0, prompt, onProgress: this.progressLogger(record.logPath, options.onProgress) }), 1);
      this.recordExecutionResult(record.metadataPath, record.logPath, result, result.sessionId ?? null);
      await this.runtimeStore.runPhase(record.metadataPath, record.logPath, 'finalization', () => {
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
      });
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
