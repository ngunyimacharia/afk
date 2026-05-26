import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { RuntimeMetadataRecord } from './types.js';

export interface SummaryReporterInput {
  repoRoot: string;
  permission?: RawLogPermissionGate;
}

export interface RawLogPermissionRequest {
  scope: string;
  reason: string;
}

export interface RawLogPermissionGate {
  request: (request: RawLogPermissionRequest) => Promise<boolean>;
}

export interface SummaryReport {
  message: string;
  rawLogsInspected: boolean;
}

interface IssueFileRecord {
  feature: string;
  issueName: string;
  filePath: string;
  status?: string;
  summaries: SummaryAttempt[];
}

interface SummaryAttempt {
  text: string;
  fields: Record<string, string>;
  index: number;
}

interface SummaryGroupItem {
  issue: IssueFileRecord;
  attempt?: SummaryAttempt;
  metadata?: RuntimeMetadataRecord;
}

interface SlowPhaseRecord {
  ticket: string;
  phase: string;
  cycle?: number;
  durationMs: number;
}

interface FailureKindGroup {
  kind: string;
  count: number;
  durationMs: number;
}

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function exists(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function parseFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return {};
  return (YAML.parse(content.slice(4, end)) ?? {}) as Record<string, unknown>;
}

function parseStatus(content: string, frontmatter: Record<string, unknown>): string | undefined {
  const frontmatterStatus = frontmatter.status;
  if (typeof frontmatterStatus === 'string' && frontmatterStatus.trim()) return frontmatterStatus.trim();
  void content;
  return undefined;
}

function extractSummaries(content: string): SummaryAttempt[] {
  const blocks = [...content.matchAll(/(?:^|\r?\n)##\s+AFK Summary\s*\r?\n([\s\S]*?)(?=(?:\r?\n##\s+)|$)/gi)];
  return blocks.map((match, index) => {
    const text = (match[1] ?? '').trim();
    return { text, fields: parseFields(text), index };
  });
}

function parseFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z /-]+):\s*(.*)$/);
    if (match) fields[match[1].trim().toLowerCase()] = match[2].trim();
  }
  return fields;
}

function fieldValue(fields: Record<string, string>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = fields[name.toLowerCase()];
    if (value) return value;
  }
  return undefined;
}

function classify(
  status: string | undefined,
  attempt: SummaryAttempt,
): 'completed' | 'failed' | 'interrupted' | 'handoff' | 'missing' | 'other' {
  const normalized = normalize(status);
  const text = `${attempt.text} ${Object.values(attempt.fields).join(' ')}`.toLowerCase();
  if (
    normalized.includes('done') ||
    normalized.includes('closed') ||
    normalized.includes('complete') ||
    text.includes('completed') ||
    text.includes('success')
  )
    return 'completed';
  if (normalized.includes('handoff') || text.includes('handoff') || text.includes('manual review')) return 'handoff';
  if (
    normalized.includes('fail') ||
    normalized.includes('block') ||
    text.includes('failed') ||
    text.includes('blocked')
  )
    return 'failed';
  if (
    normalized.includes('interrupt') ||
    normalized.includes('incomplete') ||
    text.includes('interrupted') ||
    text.includes('incomplete')
  )
    return 'interrupted';
  return 'other';
}

function readIssueFiles(repoRoot: string): IssueFileRecord[] {
  const scratchRoot = path.join(repoRoot, '.scratch');
  if (!exists(scratchRoot)) return [];
  const features = readdirSync(scratchRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  return features.flatMap((featureDir) => {
    const issuesDir = path.join(scratchRoot, featureDir.name, 'issues');
    if (!exists(issuesDir)) return [];
    return readdirSync(issuesDir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => {
        const filePath = path.join(issuesDir, file);
        const content = readFileSync(filePath, 'utf8');
        const frontmatter = parseFrontmatter(content);
        return {
          feature: featureDir.name,
          issueName: path.basename(file, '.md'),
          filePath,
          status: parseStatus(content, frontmatter),
          summaries: extractSummaries(content),
        };
      });
  });
}

function readRuntimeMetadata(repoRoot: string): RuntimeMetadataRecord[] {
  const metadataRoot = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata');
  if (!exists(metadataRoot)) return [];
  return readdirSync(metadataRoot)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(path.join(metadataRoot, file), 'utf8')) as RuntimeMetadataRecord);
}

function formatAttempt(item: SummaryGroupItem): string {
  const { issue, attempt, metadata } = item;
  const session =
    fieldValue(attempt?.fields ?? {}, 'session or run id', 'session/run id', 'session id') ??
    metadata?.PROVIDER_SESSION_ID ??
    undefined;
  const malformedReviewerCount = (metadata?.REVIEW_CYCLE_HISTORY ?? []).filter((entry) => entry.malformed).length;
  const reviewCycleCount = metadata?.REVIEW_CYCLE_HISTORY?.length;
  const fixupCycleCount = (metadata?.PHASE_HISTORY ?? []).filter((entry) => entry.name === 'fixup').length;
  const readinessBlocker =
    metadata?.STATUS === 'blocked' || metadata?.RUN_STATUS === 'blocked'
      ? (metadata.FAILURE_KIND ?? metadata.UNSAFE_REASON ?? undefined)
      : undefined;
  const bits = [
    `- ${issue.feature}/${issue.issueName}`,
    issue.status ? `status: ${issue.status}` : null,
    metadata?.RUN_STATUS ? `run: ${metadata.RUN_STATUS}` : metadata?.STATUS ? `runtime: ${metadata.STATUS}` : null,
    metadata?.IMPLEMENTATION_STATUS ? `implementation: ${metadata.IMPLEMENTATION_STATUS}` : null,
    metadata?.REVIEW_STATUS ? `review: ${metadata.REVIEW_STATUS}` : null,
    metadata?.START_TIME ? `started: ${metadata.START_TIME}` : null,
    fieldValue(attempt?.fields ?? {}, 'timestamp')
      ? `timestamp: ${fieldValue(attempt?.fields ?? {}, 'timestamp')}`
      : null,
    session ? `session: ${session}` : null,
    fieldValue(attempt?.fields ?? {}, 'outcome', 'result')
      ? `outcome: ${fieldValue(attempt?.fields ?? {}, 'outcome', 'result')}`
      : null,
    fieldValue(attempt?.fields ?? {}, 'commits') ? `commits: ${fieldValue(attempt?.fields ?? {}, 'commits')}` : null,
    fieldValue(attempt?.fields ?? {}, 'notable changes', 'changes')
      ? `changes: ${fieldValue(attempt?.fields ?? {}, 'notable changes', 'changes')}`
      : null,
    fieldValue(attempt?.fields ?? {}, 'files or areas touched', 'touched areas', 'files touched')
      ? `touched: ${fieldValue(attempt?.fields ?? {}, 'files or areas touched', 'touched areas', 'files touched')}`
      : null,
    fieldValue(attempt?.fields ?? {}, 'tests or checks run', 'verification', 'tests run')
      ? `verification: ${fieldValue(attempt?.fields ?? {}, 'tests or checks run', 'verification', 'tests run')}`
      : null,
    typeof reviewCycleCount === 'number' ? `review cycles: ${reviewCycleCount}` : null,
    metadata?.FAILURE_KIND ? `failure kind: ${metadata.FAILURE_KIND}` : null,
    typeof malformedReviewerCount === 'number' && malformedReviewerCount > 0
      ? `malformed reviewer outputs: ${malformedReviewerCount}`
      : null,
    typeof fixupCycleCount === 'number' && fixupCycleCount > 0 ? `fixup cycles: ${fixupCycleCount}` : null,
    readinessBlocker ? `readiness blocker: ${readinessBlocker}` : null,
    fieldValue(attempt?.fields ?? {}, 'blockers or errors', 'blockers', 'errors')
      ? `blockers: ${fieldValue(attempt?.fields ?? {}, 'blockers or errors', 'blockers', 'errors')}`
      : null,
    fieldValue(attempt?.fields ?? {}, 'next action', 'next step')
      ? `next: ${fieldValue(attempt?.fields ?? {}, 'next action', 'next step')}`
      : null,
    attempt?.text ? attempt.text : null,
  ].filter(Boolean);
  return bits.join('\n');
}

function summarizeSlowPhases(metadata: RuntimeMetadataRecord[]): string[] {
  const slowPhases: SlowPhaseRecord[] = metadata.flatMap((entry) => {
    const ticket = `${entry.FEATURE_SLUG}/${entry.ISSUE_NAME}`;
    return (entry.PHASE_HISTORY ?? []).map((phase) => ({
      ticket,
      phase: phase.name,
      cycle: phase.cycle,
      durationMs: phase.durationMs,
    }));
  });
  if (!slowPhases.length) return ['- none'];

  const byPhase = new Map<string, SlowPhaseRecord>();
  for (const item of slowPhases) {
    const existing = byPhase.get(item.phase);
    if (!existing || item.durationMs > existing.durationMs) byPhase.set(item.phase, item);
  }

  const topOverall = [...slowPhases]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 3)
    .map(
      (item) =>
        `- ${item.ticket} ${item.phase}${typeof item.cycle === 'number' ? `#${item.cycle}` : ''}: ${item.durationMs}ms`,
    );

  const byPhaseLines = [...byPhase.values()]
    .sort((a, b) => b.durationMs - a.durationMs)
    .map(
      (item) =>
        `- ${item.phase}: ${item.ticket}${typeof item.cycle === 'number' ? `#${item.cycle}` : ''} (${item.durationMs}ms)`,
    );

  return [
    'Overall slowest phases',
    ...(topOverall.length ? topOverall : ['- none']),
    '',
    'Slowest by phase category',
    ...(byPhaseLines.length ? byPhaseLines : ['- none']),
  ];
}

function summarizeFailureKinds(metadata: RuntimeMetadataRecord[]): string[] {
  const groups = new Map<string, FailureKindGroup>();
  for (const entry of metadata) {
    const kind = entry.FAILURE_KIND?.trim();
    if (!kind) continue;
    const durationMs = (entry.PHASE_HISTORY ?? []).reduce((total, phase) => total + phase.durationMs, 0);
    const existing = groups.get(kind) ?? { kind, count: 0, durationMs: 0 };
    existing.count += 1;
    existing.durationMs += durationMs;
    groups.set(kind, existing);
  }
  const sorted = [...groups.values()].sort(
    (a, b) => b.durationMs - a.durationMs || b.count - a.count || a.kind.localeCompare(b.kind),
  );
  return sorted.length
    ? sorted.map((group) => `- ${group.kind}: ${group.count} run${group.count === 1 ? '' : 's'}, ${group.durationMs}ms`)
    : ['- none'];
}

export class SummaryReporter {
  constructor(private readonly input: SummaryReporterInput) {}

  async summarize(): Promise<SummaryReport> {
    const issues = readIssueFiles(this.input.repoRoot);
    const metadata = readRuntimeMetadata(this.input.repoRoot);
    const byTicket = new Map(metadata.map((entry) => [path.basename(entry.TICKET_PATH), entry]));
    const completed: string[] = [];
    const handoff: string[] = [];
    const failed: string[] = [];
    const interrupted: string[] = [];
    const missing: string[] = [];
    const repeated: string[] = [];

    for (const issue of issues) {
      if (!issue.summaries.length) {
        missing.push(`- ${issue.feature}/${issue.issueName} (${issue.filePath})`);
        continue;
      }
      if (issue.summaries.length > 1)
        repeated.push(`- ${issue.feature}/${issue.issueName}: ${issue.summaries.length} attempts`);
      for (const attempt of issue.summaries) {
        const runtime =
          byTicket.get(`${issue.issueName}.md`) ??
          metadata.find((entry) => entry.FEATURE_SLUG === issue.feature && entry.ISSUE_NAME === issue.issueName);
        const rendered = formatAttempt({ issue, attempt, metadata: runtime });
        const bucket = classify(issue.status, attempt);
        if (bucket === 'completed') completed.push(rendered);
        else if (bucket === 'handoff') handoff.push(rendered);
        else if (bucket === 'failed') failed.push(rendered);
        else if (bucket === 'interrupted') interrupted.push(rendered);
      }
    }

    const lines = [
      'AFK Summary',
      '',
      'Completed or successful work',
      ...(completed.length ? completed : ['- none']),
      '',
      'Handoff or manual review',
      ...(handoff.length ? handoff : ['- none']),
      '',
      'Failed or blocked work',
      ...(failed.length ? failed : ['- none']),
      '',
      'Interrupted or incomplete work',
      ...(interrupted.length ? interrupted : ['- none']),
      '',
      'Missing summaries',
      ...(missing.length ? missing : ['- none']),
      '',
      'Repeated attempts',
      ...(repeated.length ? repeated : ['- none']),
      '',
      'Phase timing highlights',
      ...summarizeSlowPhases(metadata),
      '',
      'Failure kind totals',
      ...summarizeFailureKinds(metadata),
    ];

    const permission = this.input.permission;
    if (!permission) {
      lines.push('', 'Raw logs were not inspected because permission was not granted for this invocation.');
      return { message: lines.join('\n'), rawLogsInspected: false };
    }

    const granted = await permission.request({
      scope: '.scratch/.opencode-afk-logs/',
      reason: 'fill missing summaries and clarify incomplete or contradictory AFK results',
    });
    lines.push(
      '',
      granted
        ? 'Raw logs were permitted for this invocation.'
        : 'Raw logs were not inspected because permission was denied.',
    );
    return { message: lines.join('\n'), rawLogsInspected: granted };
  }
}
