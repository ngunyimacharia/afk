import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeMetadataRecord } from './types.js';

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

  constructor(input: RuntimeStoreInput) {
    this.logRoot = path.join(input.repoRoot, '.scratch', '.opencode-afk-logs');
    this.metadataRoot = path.join(this.logRoot, 'runtime-metadata');
    this.sentinelRoot = path.join(this.logRoot, 'sentinels');
  }

  createRecord(context: RuntimeTicketContext): RuntimeRecordHandle {
    mkdirSync(this.metadataRoot, { recursive: true });
    mkdirSync(this.sentinelRoot, { recursive: true });
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

  markDone(handle: RuntimeRecordHandle): void {
    writeFileSync(handle.doneSentinelPath, `${isoNow()} done\n`, 'utf8');
  }

  markFailed(handle: RuntimeRecordHandle, reason: string): void {
    writeFileSync(handle.failedSentinelPath, `${isoNow()} ${reason}\n`, 'utf8');
  }

  private writeMetadata(metadataPath: string, record: RuntimeMetadataRecord): void {
    mkdirSync(path.dirname(metadataPath), { recursive: true });
    writeFileSync(metadataPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }
}
