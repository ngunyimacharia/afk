import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import type { LaunchPreferences, ReviewCycleHistoryEntry, ReviewTerminalOutcomeRecord, RuntimeMetadataRecord } from './types.js';

export interface RuntimeStoreInput {
  repoRoot: string;
}

export interface RuntimeTicketContext {
  featureSlug: string;
  issueName: string;
  ticketPath: string;
}

export interface RuntimeRecordHandle {
  metadataPath: string;
  logPath: string;
  doneSentinelPath: string;
  failedSentinelPath: string;
}

function isoNow(): string {
  return new Date().toISOString();
}

export class RuntimeStore {
  private readonly logRoot: string;
  private readonly metadataRoot: string;
  private readonly sentinelRoot: string;
  private readonly launchPreferencesPath: string;

  constructor(input: RuntimeStoreInput) {
    this.logRoot = path.join(input.repoRoot, '.scratch', '.opencode-afk-logs');
    this.metadataRoot = path.join(this.logRoot, 'runtime-metadata');
    this.sentinelRoot = path.join(this.logRoot, 'sentinels');
    this.launchPreferencesPath = path.join(this.logRoot, 'launch-preferences.json');
  }

  readLaunchPreferences(): LaunchPreferences {
    if (!existsSync(this.launchPreferencesPath)) return {};
    try {
      const value = JSON.parse(readFileSync(this.launchPreferencesPath, 'utf8')) as Record<string, unknown> | null;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      const preferences: LaunchPreferences = {
        harness: value.harness === 'OpenCode' ? 'OpenCode' : undefined,
        modelId: typeof value.modelId === 'string' ? value.modelId : undefined,
        reviewerModelId: typeof value.reviewerModelId === 'string' ? value.reviewerModelId : undefined,
      };
      if (typeof value.concurrency === 'number' && Number.isInteger(value.concurrency) && value.concurrency > 0) preferences.concurrency = value.concurrency;
      return preferences;
    } catch (_error) {
      return {};
    }
  }

  writeLaunchPreferences(preferences: LaunchPreferences): void {
    mkdirSync(path.dirname(this.launchPreferencesPath), { recursive: true });
    writeFileSync(this.launchPreferencesPath, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8');
  }

  createRecord(context: RuntimeTicketContext): RuntimeRecordHandle {
    mkdirSync(this.metadataRoot, { recursive: true });
    mkdirSync(this.sentinelRoot, { recursive: true });
    mkdirSync(this.logRoot, { recursive: true });
    const logPath = path.join(this.logRoot, `${context.featureSlug}-${context.issueName}.log`);
    const metadataPath = path.join(this.metadataRoot, `${context.featureSlug}-${context.issueName}.json`);
    const doneSentinelPath = path.join(this.sentinelRoot, `${context.featureSlug}-${context.issueName}.done`);
    const failedSentinelPath = path.join(this.sentinelRoot, `${context.featureSlug}-${context.issueName}.failed`);
    this.writeMetadata(metadataPath, {
      TICKET_PATH: context.ticketPath,
      FEATURE_SLUG: context.featureSlug,
      ISSUE_NAME: context.issueName,
      LOG_PATH: logPath,
      START_TIME: isoNow(),
      START_EPOCH: Date.now(),
      DONE_SENTINEL_PATH: doneSentinelPath,
      FAILED_SENTINEL_PATH: failedSentinelPath,
      STATUS: 'running',
      EXECUTION_PROVIDER: 'opencode',
      PROVIDER_SESSION_ID: null,
      PROVIDER_SESSION_REMOVABLE: false,
      INSPECTION_PROVIDER: null,
      INSPECTION_TARGET_IDENTIFIER: null,
      REVIEW_CYCLE_HISTORY: [],
      FINAL_REVIEW_OUTCOME: null,
      FINAL_REVIEW_REASON: null,
      FINAL_REVIEW_CYCLE: null,
      UNSAFE_REASON: 'session capture pending',
    });
    return { metadataPath, logPath, doneSentinelPath, failedSentinelPath };
  }

  appendLog(logPath: string, line: string): void {
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${line}\n`, 'utf8');
  }

  readMetadata(metadataPath: string): RuntimeMetadataRecord {
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

  recordFinalReviewOutcome(metadataPath: string, logPath: string, outcome: ReviewTerminalOutcomeRecord): RuntimeMetadataRecord {
    const current = this.readMetadata(metadataPath);
    const next = this.writeMetadataAndReturn(metadataPath, {
      ...current,
      FINAL_REVIEW_OUTCOME: outcome.outcome,
      FINAL_REVIEW_REASON: outcome.reason,
      FINAL_REVIEW_CYCLE: outcome.cycle,
    });
    this.appendLog(logPath, JSON.stringify({ event: 'review-terminal', ...outcome }));
    return next;
  }

  markDone(handle: RuntimeRecordHandle): void {
    mkdirSync(path.dirname(handle.doneSentinelPath), { recursive: true });
    writeFileSync(handle.doneSentinelPath, `${isoNow()} done\n`, 'utf8');
  }

  markFailed(handle: RuntimeRecordHandle, reason: string): void {
    mkdirSync(path.dirname(handle.failedSentinelPath), { recursive: true });
    writeFileSync(handle.failedSentinelPath, `${isoNow()} ${reason}\n`, 'utf8');
  }

  private writeMetadata(metadataPath: string, record: RuntimeMetadataRecord): void {
    mkdirSync(path.dirname(metadataPath), { recursive: true });
    writeFileSync(metadataPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  private writeMetadataAndReturn(metadataPath: string, record: RuntimeMetadataRecord): RuntimeMetadataRecord {
    this.writeMetadata(metadataPath, record);
    return record;
  }
}
