import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  countLeftoverBranches,
  countLeftoverWorktrees,
  readPendingPostMergeCleanupItems,
  safeRealpath,
} from './cleanup.js';
import type { SandcastleRuntimeRecord } from './sandcastle-runtime-store.js';
import type { TrackerProvider } from './tracker-contract.js';

export interface SummaryReporterInput {
  repoRoot: string;
  source?: SummaryIssueSource;
  permission?: RawLogPermissionGate;
}

export interface SummaryIssueSource {
  listIssueSummaries(): Promise<IssueFileRecord[]> | IssueFileRecord[];
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

export interface IssueFileRecord {
  feature: string;
  issueName: string;
  filePath: string;
  status?: string;
  summaries: SummaryAttempt[];
}

export interface SummaryAttempt {
  text: string;
  fields: Record<string, string>;
  index: number;
}

interface SummaryGroupItem {
  issue: IssueFileRecord;
  attempt?: SummaryAttempt;
  runtime?: SandcastleRuntimeRecord;
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

function getNoSummaryBucket(status: string | undefined): 'not-yet-started' | 'wontfix' | 'legacy' | 'missing' {
  const normalized = normalize(status);
  if (!normalized) return 'legacy';
  if (['ready-for-agent', 'ready-for-human', 'needs-triage', 'needs-info'].includes(normalized))
    return 'not-yet-started';
  if (normalized === 'wontfix') return 'wontfix';
  return 'missing';
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

function classifyRuntime(
  runtime: SandcastleRuntimeRecord,
): 'completed' | 'failed' | 'interrupted' | 'handoff' | 'other' {
  const status = normalize(runtime.terminal.status);
  if (status === 'completed') return 'completed';
  if (status === 'handoff' || status === 'blocked') return 'handoff';
  if (status === 'failed') return 'failed';
  if (status === 'interrupted') return 'interrupted';
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

export class ScratchSummaryIssueSource implements SummaryIssueSource {
  constructor(private readonly repoRoot: string) {}

  listIssueSummaries(): IssueFileRecord[] {
    return readIssueFiles(this.repoRoot);
  }
}

export class TrackerProviderSummaryIssueSource implements SummaryIssueSource {
  constructor(private readonly provider: TrackerProvider) {}

  async listIssueSummaries(): Promise<IssueFileRecord[]> {
    const items = await this.provider.list();
    return items.map((item) => ({
      feature: item.feature,
      issueName: item.issueName,
      filePath: item.materializedFiles?.ticketPath ?? item.url ?? item.providerRef.url ?? item.label,
      status: item.status,
      summaries: extractSummaries(item.body),
    }));
  }
}

function sandcastleRuntimeRoot(repoRoot: string): string {
  return path.join(repoRoot, '.scratch', 'sandcastle-runtime', 'runs');
}

function readSandcastleRuntimeRecords(repoRoot: string): SandcastleRuntimeRecord[] {
  const runsRoot = sandcastleRuntimeRoot(repoRoot);
  if (!exists(runsRoot)) return [];
  return readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsRoot, entry.name, 'record.json'))
    .filter((recordPath) => {
      try {
        return statSync(recordPath).isFile();
      } catch {
        return false;
      }
    })
    .map((recordPath) => JSON.parse(readFileSync(recordPath, 'utf8')) as SandcastleRuntimeRecord);
}

function formatAttempt(item: SummaryGroupItem): string {
  const { issue, attempt, runtime } = item;
  const session =
    fieldValue(attempt?.fields ?? {}, 'session or run id', 'session/run id', 'session id') ?? runtime?.runId;
  const cleanupStatus = runtime?.cleanupResults?.length
    ? runtime.cleanupResults.map((result) => `${result.resourceType}:${result.resourceId}:${result.status}`).join(', ')
    : runtime?.cleanupResources.length
      ? 'pending'
      : undefined;
  const bits = [
    `- ${issue.feature}/${issue.issueName}`,
    issue.status ? `status: ${issue.status}` : null,
    runtime?.trackerSource ? `provider: ${runtime.trackerSource}` : null,
    runtime?.provider.provider ? `execution provider: ${runtime.provider.provider}` : null,
    runtime?.provider.model ? `model: ${runtime.provider.model}` : null,
    runtime?.sandbox.mode ? `sandbox: ${runtime.sandbox.mode}` : null,
    runtime?.branch ? `branch: ${runtime.branch}` : null,
    runtime?.worktreePath ? `worktree: ${runtime.worktreePath}` : null,
    runtime?.terminal.status ? `terminal: ${runtime.terminal.status}` : null,
    runtime?.trackerSource === 'linear' && runtime.ticket.trackerIssueKey
      ? `linear issue: ${runtime.ticket.trackerIssueKey}`
      : null,
    runtime?.trackerSource === 'linear' && runtime.ticket.trackerIssueUrl
      ? `linear url: ${runtime.ticket.trackerIssueUrl}`
      : null,
    runtime?.trackerSource === 'linear' && runtime.ticket.ticketPath
      ? `linear mirror: ${runtime.ticket.ticketPath}`
      : null,
    cleanupStatus ? `cleanup: ${cleanupStatus}` : null,
    runtime?.createdAt ? `started: ${runtime.createdAt}` : null,
    fieldValue(attempt?.fields ?? {}, 'timestamp')
      ? `timestamp: ${fieldValue(attempt?.fields ?? {}, 'timestamp')}`
      : null,
    session ? `session: ${session}` : null,
    fieldValue(attempt?.fields ?? {}, 'outcome', 'result')
      ? `outcome: ${fieldValue(attempt?.fields ?? {}, 'outcome', 'result')}`
      : null,
    fieldValue(attempt?.fields ?? {}, 'commits') ? `commits: ${fieldValue(attempt?.fields ?? {}, 'commits')}` : null,
    !fieldValue(attempt?.fields ?? {}, 'commits') && runtime?.commits.length
      ? `commits: ${runtime.commits.map((commit) => commit.sha).join(', ')}`
      : null,
    fieldValue(attempt?.fields ?? {}, 'notable changes', 'changes')
      ? `changes: ${fieldValue(attempt?.fields ?? {}, 'notable changes', 'changes')}`
      : null,
    fieldValue(attempt?.fields ?? {}, 'files or areas touched', 'touched areas', 'files touched')
      ? `touched: ${fieldValue(attempt?.fields ?? {}, 'files or areas touched', 'touched areas', 'files touched')}`
      : null,
    fieldValue(attempt?.fields ?? {}, 'tests or checks run', 'verification', 'tests run')
      ? `verification: ${fieldValue(attempt?.fields ?? {}, 'tests or checks run', 'verification', 'tests run')}`
      : null,
    runtime?.phases.length
      ? `phases: ${runtime.phases.map((phase) => `${phase.phase}#${phase.attempt}:${phase.status}`).join(', ')}`
      : null,
    runtime?.terminal.handoffReason ? `handoff reason: ${runtime.terminal.handoffReason}` : null,
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

function summarizeSlowPhases(records: SandcastleRuntimeRecord[]): string[] {
  const slowPhases: SlowPhaseRecord[] = records
    .flatMap((entry) => {
      const ticket = entry.ticket.label;
      return entry.phases.map((phase) => ({
        ticket,
        phase: phase.phase,
        cycle: phase.attempt,
        durationMs: phase.durationMs ?? 0,
      }));
    })
    .filter((phase) => phase.durationMs > 0);
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

function summarizeTerminalStates(records: SandcastleRuntimeRecord[]): string[] {
  const groups = new Map<string, FailureKindGroup>();
  for (const entry of records) {
    const kind = entry.terminal.status;
    const durationMs = entry.phases.reduce((total, phase) => total + (phase.durationMs ?? 0), 0);
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

function isActiveRuntimeStatus(status: string | undefined): boolean {
  const terminal = new Set([
    'completed',
    'failed',
    'blocked',
    'interrupted',
    'handoff',
    'done',
    'closed',
    'complete',
    'resolved',
  ]);
  return !terminal.has(normalize(status));
}

function summarizeLeftoverCounts(repoRoot: string, records: SandcastleRuntimeRecord[]): string[] {
  const activeTickets = new Set<string>();
  const activeWorktreePaths = new Set<string>();
  for (const entry of records) {
    if (!isActiveRuntimeStatus(entry.terminal.status)) continue;
    activeTickets.add(`${entry.ticket.featureSlug}/${entry.ticket.issueName}`);
    activeWorktreePaths.add(safeRealpath(entry.worktreePath));
  }
  const branchCount = countLeftoverBranches(repoRoot, activeTickets);
  const worktreeCount = countLeftoverWorktrees(repoRoot, activeWorktreePaths);
  return [`- leftover branches: ${branchCount}`, `- leftover worktrees: ${worktreeCount}`];
}

function summarizePendingPostMergeCleanup(repoRoot: string): string[] {
  const items = readPendingPostMergeCleanupItems(repoRoot);
  if (!items.length) return ['- none'];
  return [
    `count: ${items.length}`,
    ...items.map(
      (item) =>
        `- ${item.feature}/${item.issueName} branch=${item.branchName} worktree=${item.worktreePath} reason=${item.warning ?? item.error ?? 'pending retry'}`,
    ),
  ];
}

export class SummaryReporter {
  constructor(private readonly input: SummaryReporterInput) {}

  async summarize(): Promise<SummaryReport> {
    const records = readSandcastleRuntimeRecords(this.input.repoRoot);
    const completed: string[] = [];
    const handoff: string[] = [];
    const failed: string[] = [];
    const interrupted: string[] = [];
    const notYetStarted: string[] = [];
    const wontFix: string[] = [];
    const legacy: string[] = [];
    const missing: string[] = [];
    const repeated: string[] = [];

    if (records.length > 0) {
      for (const runtime of records) {
        const issue = {
          feature: runtime.ticket.featureSlug,
          issueName: runtime.ticket.issueName,
          filePath: runtime.ticket.ticketPath,
          status: runtime.terminal.status,
          summaries: [],
        } satisfies IssueFileRecord;
        const rendered = formatAttempt({ issue, runtime });
        const bucket = classifyRuntime(runtime);
        if (bucket === 'completed') completed.push(rendered);
        else if (bucket === 'handoff') handoff.push(rendered);
        else if (bucket === 'failed') failed.push(rendered);
        else if (bucket === 'interrupted') interrupted.push(rendered);
      }
    } else {
      const source = this.input.source ?? new ScratchSummaryIssueSource(this.input.repoRoot);
      const issues = await source.listIssueSummaries();
      for (const issue of issues) {
        if (!issue.summaries.length) {
          const bucket = getNoSummaryBucket(issue.status);
          const line = `- ${issue.feature}/${issue.issueName} (${issue.filePath})`;
          if (bucket === 'not-yet-started') notYetStarted.push(line);
          else if (bucket === 'wontfix') wontFix.push(line);
          else if (bucket === 'legacy') legacy.push(line);
          else missing.push(line);
          continue;
        }
        if (issue.summaries.length > 1)
          repeated.push(`- ${issue.feature}/${issue.issueName}: ${issue.summaries.length} attempts`);
        for (const attempt of issue.summaries) {
          const rendered = formatAttempt({ issue, attempt });
          const bucket = classify(issue.status, attempt);
          if (bucket === 'completed') completed.push(rendered);
          else if (bucket === 'handoff') handoff.push(rendered);
          else if (bucket === 'failed') failed.push(rendered);
          else if (bucket === 'interrupted') interrupted.push(rendered);
        }
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
      'Not yet started',
      ...(notYetStarted.length ? notYetStarted : ['- none']),
      '',
      "Won't fix",
      ...(wontFix.length ? wontFix : ['- none']),
      '',
      'Legacy / malformed',
      ...(legacy.length ? legacy : ['- none']),
      '',
      'Missing summaries',
      ...(missing.length ? missing : ['- none']),
      '',
      'Repeated attempts',
      ...(repeated.length ? repeated : ['- none']),
      '',
      'Phase timing highlights',
      ...summarizeSlowPhases(records),
      '',
      'Terminal state totals',
      ...summarizeTerminalStates(records),
      '',
      'Leftover cleanup counts',
      ...summarizeLeftoverCounts(this.input.repoRoot, records),
      '',
      'Pending post-merge cleanup debt',
      ...summarizePendingPostMergeCleanup(this.input.repoRoot),
    ];

    const permission = this.input.permission;
    if (!permission) {
      lines.push('', 'Legacy raw logs were not inspected; summary reads Sandcastle runtime records only.');
      return { message: lines.join('\n'), rawLogsInspected: false };
    }

    const granted = await permission.request({
      scope: '.scratch/sandcastle-runtime/',
      reason: 'inspect Sandcastle runtime records for AFK summary reporting',
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
