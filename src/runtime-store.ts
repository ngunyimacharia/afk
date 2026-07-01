import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isSelectableHarnessId } from './harness-registry.js';
import { assertPathWithinRoot } from './path-validation.js';
import type {
  BudgetExceededEvent,
  BudgetPolicy,
  FeatureCompletionAction,
  LaunchPreferences,
  LinearProviderIdentity,
  PhaseHistoryEntry,
  ReviewCycleHistoryEntry,
  ReviewTerminalOutcomeRecord,
  RuntimeMetadataRecord,
  SandboxMode,
} from './types.js';

export interface RuntimeStoreInput {
  repoRoot: string;
  now?: () => number;
}

export interface RuntimeTicketContext {
  featureSlug: string;
  issueName: string;
  ticketPath: string;
  runId?: string;
  providerIdentity?: LinearProviderIdentity;
  sandboxMode?: SandboxMode;
}

export interface RuntimeRecordHandle {
  metadataPath: string;
  logPath: string;
  doneSentinelPath: string;
  failedSentinelPath: string;
  handoffSentinelPath: string;
}

interface RuntimePhase {
  name: string;
  startEpoch: number;
  startTime: string;
  cycle?: number;
}

function isoFromEpoch(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function isFeatureCompletionAction(value: unknown): value is FeatureCompletionAction {
  return value === 'merge-to-base' || value === 'create-pr';
}

function resolveFeatureCompletionAction(value: Record<string, unknown>): FeatureCompletionAction | undefined {
  if (isFeatureCompletionAction(value.featureCompletionAction)) return value.featureCompletionAction;
  if (typeof value.mergeBackToBase === 'boolean') return value.mergeBackToBase ? 'merge-to-base' : 'create-pr';
  return undefined;
}

function parseSandcastleSandboxMode(value: unknown): LaunchPreferences['sandcastleSandboxMode'] {
  return value === 'docker' || value === 'no-sandbox' ? value : undefined;
}

export class RuntimeStore {
  private readonly logRoot: string;
  private readonly metadataRoot: string;
  private readonly sentinelRoot: string;
  private readonly launchPreferencesPath: string;
  private readonly now: () => number;
  private readonly logRootResolved: string;

  constructor(input: RuntimeStoreInput) {
    this.logRoot = path.join(input.repoRoot, '.scratch', '.opencode-afk-logs');
    this.logRootResolved = path.resolve(this.logRoot);
    this.metadataRoot = path.join(this.logRoot, 'runtime-metadata');
    this.sentinelRoot = path.join(this.logRoot, 'sentinels');
    this.launchPreferencesPath = path.join(this.logRoot, 'launch-preferences.json');
    this.now = input.now ?? Date.now;
  }

  readLaunchPreferences(): LaunchPreferences {
    this.assertManagedPath(this.launchPreferencesPath, 'launch preferences');
    if (!existsSync(this.launchPreferencesPath)) return {};
    try {
      const value = JSON.parse(readFileSync(this.launchPreferencesPath, 'utf8')) as Record<string, unknown> | null;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      const sandcastleSandboxMode = parseSandcastleSandboxMode(value.sandcastleSandboxMode);
      const harnessValue = typeof value.harness === 'string' ? value.harness : undefined;
      const reviewerHarnessValue = typeof value.reviewerHarness === 'string' ? value.reviewerHarness : undefined;
      const preferences: LaunchPreferences = {
        harness: harnessValue && isSelectableHarnessId(harnessValue) ? harnessValue : undefined,
        modelId: typeof value.modelId === 'string' ? value.modelId : undefined,
        reviewerHarness:
          reviewerHarnessValue && isSelectableHarnessId(reviewerHarnessValue) ? reviewerHarnessValue : undefined,
        reviewerModelId: typeof value.reviewerModelId === 'string' ? value.reviewerModelId : undefined,
        sandboxMode:
          value.sandboxMode === 'docker' || value.sandboxMode === 'no-sandbox' ? value.sandboxMode : undefined,
        ...(sandcastleSandboxMode ? { sandcastleSandboxMode } : {}),
      };
      if (typeof value.concurrency === 'number' && Number.isInteger(value.concurrency) && value.concurrency > 0)
        preferences.concurrency = value.concurrency;
      const featureCompletionAction = resolveFeatureCompletionAction(value);
      if (featureCompletionAction) preferences.featureCompletionAction = featureCompletionAction;
      const budgets = value.budgets;
      if (budgets && typeof budgets === 'object' && !Array.isArray(budgets)) {
        const budgetRecord = budgets as Record<string, unknown>;
        const parsed: Partial<BudgetPolicy> = {};
        if (typeof budgetRecord.malformedReviewerRetries === 'number' && budgetRecord.malformedReviewerRetries >= 0)
          parsed.malformedReviewerRetries = Math.floor(budgetRecord.malformedReviewerRetries);
        if (typeof budgetRecord.fixupCycleLimit === 'number' && budgetRecord.fixupCycleLimit > 0)
          parsed.fixupCycleLimit = Math.floor(budgetRecord.fixupCycleLimit);
        if (typeof budgetRecord.providerFailureRetries === 'number' && budgetRecord.providerFailureRetries >= 0)
          parsed.providerFailureRetries = Math.floor(budgetRecord.providerFailureRetries);
        if (typeof budgetRecord.ticketWallClockMs === 'number' && budgetRecord.ticketWallClockMs > 0)
          parsed.ticketWallClockMs = Math.floor(budgetRecord.ticketWallClockMs);
        if (
          budgetRecord.phaseWallClockMs &&
          typeof budgetRecord.phaseWallClockMs === 'object' &&
          !Array.isArray(budgetRecord.phaseWallClockMs)
        ) {
          const phaseWallClockMs = budgetRecord.phaseWallClockMs as Record<string, unknown>;
          const phaseBudgets: Record<string, number> = {};
          for (const key of ['execution', 'review', 'fixup']) {
            if (typeof phaseWallClockMs[key] === 'number' && (phaseWallClockMs[key] as number) > 0)
              phaseBudgets[key] = Math.floor(phaseWallClockMs[key] as number);
          }
          if (Object.keys(phaseBudgets).length) parsed.phaseWallClockMs = phaseBudgets;
        }
        if (Object.keys(parsed).length) preferences.budgets = parsed;
      }
      return preferences;
    } catch (_error) {
      return {};
    }
  }

  writeLaunchPreferences(preferences: LaunchPreferences): void {
    this.assertManagedPath(this.launchPreferencesPath, 'launch preferences');
    mkdirSync(path.dirname(this.launchPreferencesPath), { recursive: true });
    const normalized: LaunchPreferences = {
      harness: preferences.harness,
      modelId: preferences.modelId,
      reviewerHarness: preferences.reviewerHarness,
      reviewerModelId: preferences.reviewerModelId,
      sandcastleSandboxMode: preferences.sandcastleSandboxMode,
      concurrency: preferences.concurrency,
      budgets: preferences.budgets,
      featureCompletionAction: preferences.featureCompletionAction,
      sandboxMode: preferences.sandboxMode,
    };
    writeFileSync(this.launchPreferencesPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  }

  createRecord(context: RuntimeTicketContext): RuntimeRecordHandle {
    mkdirSync(this.metadataRoot, { recursive: true });
    mkdirSync(this.sentinelRoot, { recursive: true });
    mkdirSync(this.logRoot, { recursive: true });
    const logPath = path.join(this.logRoot, `${context.featureSlug}-${context.issueName}.log`);
    const metadataPath = path.join(this.metadataRoot, `${context.featureSlug}-${context.issueName}.json`);
    const doneSentinelPath = path.join(this.sentinelRoot, `${context.featureSlug}-${context.issueName}.done`);
    const failedSentinelPath = path.join(this.sentinelRoot, `${context.featureSlug}-${context.issueName}.failed`);
    const handoffSentinelPath = path.join(this.sentinelRoot, `${context.featureSlug}-${context.issueName}.handoff`);
    const startEpoch = this.now();
    this.assertManagedPath(logPath, 'runtime log');
    this.assertManagedPath(metadataPath, 'runtime metadata');
    this.assertManagedPath(doneSentinelPath, 'done sentinel');
    this.assertManagedPath(failedSentinelPath, 'failed sentinel');
    this.assertManagedPath(handoffSentinelPath, 'handoff sentinel');
    this.writeMetadata(metadataPath, {
      ...(context.runId ? { RUN_ID: context.runId } : {}),
      TICKET_PATH: context.ticketPath,
      FEATURE_SLUG: context.featureSlug,
      ISSUE_NAME: context.issueName,
      LOG_PATH: logPath,
      START_TIME: isoFromEpoch(startEpoch),
      START_EPOCH: startEpoch,
      DONE_SENTINEL_PATH: doneSentinelPath,
      FAILED_SENTINEL_PATH: failedSentinelPath,
      ...(context.providerIdentity?.provider === 'linear'
        ? {
            LINEAR_ISSUE_ID: context.providerIdentity.issueId,
            LINEAR_ISSUE_KEY: context.providerIdentity.issueKey,
            LINEAR_ISSUE_URL: context.providerIdentity.issueUrl,
            LINEAR_PARENT_KEY: context.providerIdentity.parentKey,
            LINEAR_MIRROR_PATH: context.providerIdentity.mirrorPath ?? context.ticketPath,
            PROVIDER_IDENTITY: context.providerIdentity,
          }
        : {}),
      STATUS: 'running',
      EXECUTION_PROVIDER: 'opencode',
      SANDBOX_MODE: context.sandboxMode,
      SANDCASTLE_SANDBOX_MODE: context.sandboxMode,
      SANDCASTLE_BRANCH: undefined,
      SANDCASTLE_WORKTREE_PATH: undefined,
      SANDCASTLE_PROVIDER: undefined,
      SANDCASTLE_LOG_PATH: undefined,
      SANDCASTLE_PHASE_RESULT: undefined,
      SANDCASTLE_COMMITS: [],
      PROVIDER_SESSION_ID: null,
      PROVIDER_SESSION_REMOVABLE: false,
      INSPECTION_PROVIDER: null,
      INSPECTION_TARGET_IDENTIFIER: null,
      FAILURE_KIND: null,
      REVIEW_CYCLE_HISTORY: [],
      PHASE_HISTORY: [],
      FINAL_REVIEW_OUTCOME: null,
      FINAL_REVIEW_REASON: null,
      FINAL_REVIEW_CYCLE: null,
      BUDGET_EXCEEDED_EVENTS: [],
      FINAL_REVIEW_CLASSIFICATION: null,
      FINAL_REVIEW_MALFORMED: null,
      FINAL_REVIEW_FINDINGS: [],
      FINAL_REVIEW_MALFORMED_OUTPUT_SNIPPET: null,
      UNSAFE_REASON: 'session capture pending',
      IMPLEMENTATION_STATUS: 'not-started',
      REVIEW_STATUS: 'not-started',
      RUN_STATUS: 'unknown',
      PROVIDER_FAILURE_KIND: null,
      PROVIDER_FAILURE_SOURCE: null,
      PROVIDER_FAILURE_EVIDENCE: null,
      DETERMINISTIC_PROVIDER_FAILURE: false,
      LAST_ACTIVE_TOOL_NAME: null,
      LAST_ACTIVE_TOOL_STARTED_AT: null,
      STALE_RECOVERY_COUNTS: 0,
    });
    return { metadataPath, logPath, doneSentinelPath, failedSentinelPath, handoffSentinelPath };
  }

  startPhase(name: string, cycle?: number): RuntimePhase {
    const startEpoch = this.now();
    return {
      name,
      startEpoch,
      startTime: isoFromEpoch(startEpoch),
      cycle,
    };
  }

  completePhase(metadataPath: string, logPath: string, phase: RuntimePhase): RuntimeMetadataRecord {
    const endEpoch = this.now();
    const entry: PhaseHistoryEntry = {
      name: phase.name,
      startTime: phase.startTime,
      endTime: isoFromEpoch(endEpoch),
      durationMs: Math.max(0, endEpoch - phase.startEpoch),
      ...(phase.cycle ? { cycle: phase.cycle } : {}),
    };
    const current = this.readMetadata(metadataPath);
    const history = [...(current.PHASE_HISTORY ?? []), entry];
    const next = this.writeMetadataAndReturn(metadataPath, {
      ...current,
      PHASE_HISTORY: history,
    });
    this.appendLog(logPath, JSON.stringify({ event: 'phase', ...entry }));
    return next;
  }

  async runPhase<T>(
    metadataPath: string,
    logPath: string,
    name: string,
    action: () => Promise<T> | T,
    cycle?: number,
  ): Promise<T> {
    const phase = this.startPhase(name, cycle);
    try {
      return await action();
    } finally {
      this.completePhase(metadataPath, logPath, phase);
    }
  }

  appendLog(logPath: string, line: string): void {
    this.assertManagedPath(logPath, 'runtime log');
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${line}\n`, 'utf8');
  }

  readMetadata(metadataPath: string): RuntimeMetadataRecord {
    this.assertManagedPath(metadataPath, 'runtime metadata');
    return JSON.parse(readFileSync(metadataPath, 'utf8')) as RuntimeMetadataRecord;
  }

  updateMetadata(metadataPath: string, patch: Partial<RuntimeMetadataRecord>): RuntimeMetadataRecord {
    const current = this.readMetadata(metadataPath);
    const next = { ...current, ...patch };
    this.writeMetadata(metadataPath, next);
    return next;
  }

  recordReviewCycle(metadataPath: string, logPath: string, cycle: ReviewCycleHistoryEntry): RuntimeMetadataRecord {
    const current = this.readMetadata(metadataPath);
    const history = [...(current.REVIEW_CYCLE_HISTORY ?? []), cycle];
    const next = this.writeMetadataAndReturn(metadataPath, {
      ...current,
      REVIEW_CYCLE_HISTORY: history,
    });
    this.appendLog(logPath, JSON.stringify({ event: 'review-cycle', ...cycle }));
    return next;
  }

  recordFinalReviewOutcome(
    metadataPath: string,
    logPath: string,
    outcome: ReviewTerminalOutcomeRecord,
  ): RuntimeMetadataRecord {
    const current = this.readMetadata(metadataPath);
    const next = this.writeMetadataAndReturn(metadataPath, {
      ...current,
      FINAL_REVIEW_OUTCOME: outcome.outcome,
      FINAL_REVIEW_REASON: outcome.reason,
      FINAL_REVIEW_CYCLE: outcome.cycle,
      FINAL_REVIEW_CLASSIFICATION: outcome.classification ?? null,
      FINAL_REVIEW_MALFORMED: outcome.malformed ?? false,
      FINAL_REVIEW_FINDINGS: outcome.findings ?? [],
      FINAL_REVIEW_MALFORMED_OUTPUT_SNIPPET: outcome.malformedOutputSnippet ?? null,
    });
    this.appendLog(logPath, JSON.stringify({ event: 'review-terminal', ...outcome }));
    return next;
  }

  recordBudgetExceeded(metadataPath: string, logPath: string, event: BudgetExceededEvent): RuntimeMetadataRecord {
    const current = this.readMetadata(metadataPath);
    const history = [...(current.BUDGET_EXCEEDED_EVENTS ?? []), event];
    const next = this.writeMetadataAndReturn(metadataPath, {
      ...current,
      BUDGET_EXCEEDED_EVENTS: history,
    });
    this.appendLog(logPath, JSON.stringify({ event: 'budget-exceeded', ...event }));
    return next;
  }

  markDone(handle: RuntimeRecordHandle): void {
    this.assertManagedPath(handle.doneSentinelPath, 'done sentinel');
    mkdirSync(path.dirname(handle.doneSentinelPath), { recursive: true });
    writeFileSync(handle.doneSentinelPath, `${isoFromEpoch(this.now())} done\n`, 'utf8');
  }

  markFailed(handle: RuntimeRecordHandle, reason: string): void {
    this.assertManagedPath(handle.failedSentinelPath, 'failed sentinel');
    mkdirSync(path.dirname(handle.failedSentinelPath), { recursive: true });
    writeFileSync(handle.failedSentinelPath, `${isoFromEpoch(this.now())} ${reason}\n`, 'utf8');
  }

  markHandoff(handle: RuntimeRecordHandle, reason: string): void {
    this.assertManagedPath(handle.handoffSentinelPath, 'handoff sentinel');
    mkdirSync(path.dirname(handle.handoffSentinelPath), { recursive: true });
    writeFileSync(handle.handoffSentinelPath, `${isoFromEpoch(this.now())} ${reason}\n`, 'utf8');
  }

  private writeMetadata(metadataPath: string, record: RuntimeMetadataRecord): void {
    this.assertManagedPath(metadataPath, 'runtime metadata');
    mkdirSync(path.dirname(metadataPath), { recursive: true });
    writeFileSync(metadataPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  private writeMetadataAndReturn(metadataPath: string, record: RuntimeMetadataRecord): RuntimeMetadataRecord {
    this.writeMetadata(metadataPath, record);
    return record;
  }

  private assertManagedPath(targetPath: string, label: string): void {
    assertPathWithinRoot(targetPath, this.logRootResolved, label);
  }
}
