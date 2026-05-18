import { readFileSync, readdirSync, statSync } from 'node:fs';
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

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function exists(target: string): boolean {
  try { return statSync(target).isDirectory(); } catch { return false; }
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
  const statusLine = content.match(/^Status:\s*(.+)$/im)?.[1]?.trim();
  if (statusLine) return statusLine;
  const headingMatch = content.match(/^##\s+Status\s*$([\s\S]*?)(?:^##\s+|\Z)/im);
  const headingBody = headingMatch?.[1]?.trim();
  return headingBody ? headingBody.split(/\r?\n/)[0].trim() : undefined;
}

function extractSummaries(content: string): SummaryAttempt[] {
  const blocks = [...content.matchAll(/^##\s+AFK Summary\s*$([\s\S]*?)(?=^##\s+|\Z)/gim)];
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

function classify(status: string | undefined, attempt: SummaryAttempt): 'completed' | 'failed' | 'interrupted' | 'missing' | 'other' {
  const normalized = normalize(status);
  const text = `${attempt.text} ${Object.values(attempt.fields).join(' ')}`.toLowerCase();
  if (normalized.includes('done') || normalized.includes('closed') || normalized.includes('complete') || text.includes('completed') || text.includes('success')) return 'completed';
  if (normalized.includes('fail') || normalized.includes('block') || text.includes('failed') || text.includes('blocked')) return 'failed';
  if (normalized.includes('interrupt') || normalized.includes('incomplete') || text.includes('interrupted') || text.includes('incomplete')) return 'interrupted';
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

function formatAttempt(issue: IssueFileRecord, attempt: SummaryAttempt, metadata?: RuntimeMetadataRecord): string {
  const bits = [
    `- ${issue.feature}/${issue.issueName}`,
    issue.status ? `status: ${issue.status}` : null,
    metadata?.STATUS ? `runtime: ${metadata.STATUS}` : null,
    attempt.fields.timestamp ? `timestamp: ${attempt.fields.timestamp}` : null,
    attempt.fields['session or run id'] ? `session: ${attempt.fields['session or run id']}` : attempt.fields['session/run id'] ? `session: ${attempt.fields['session/run id']}` : null,
    attempt.text ? attempt.text : null,
  ].filter(Boolean);
  return bits.join('\n');
}

export class SummaryReporter {
  constructor(private readonly input: SummaryReporterInput) {}

  async summarize(): Promise<SummaryReport> {
    const issues = readIssueFiles(this.input.repoRoot);
    const metadata = readRuntimeMetadata(this.input.repoRoot);
    const byTicket = new Map(metadata.map((entry) => [path.basename(entry.TICKET_PATH), entry]));
    const completed: string[] = [];
    const failed: string[] = [];
    const interrupted: string[] = [];
    const missing: string[] = [];
    const repeated: string[] = [];

    for (const issue of issues) {
      if (!issue.summaries.length) {
        missing.push(`- ${issue.feature}/${issue.issueName} (${issue.filePath})`);
        continue;
      }
      if (issue.summaries.length > 1) repeated.push(`- ${issue.feature}/${issue.issueName}: ${issue.summaries.length} attempts`);
      for (const attempt of issue.summaries) {
        const runtime = byTicket.get(`${issue.issueName}.md`) ?? metadata.find((entry) => entry.FEATURE_SLUG === issue.feature && entry.ISSUE_NAME === issue.issueName);
        const rendered = formatAttempt(issue, attempt, runtime);
        const bucket = classify(issue.status, attempt);
        if (bucket === 'completed') completed.push(rendered);
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
    ];

    const permission = this.input.permission;
    if (permission) {
      const granted = await permission.request({ scope: '.scratch/.opencode-afk-logs/', reason: 'fill missing summaries and clarify incomplete or contradictory AFK results' });
      lines.push('', granted ? 'Raw logs were permitted for this invocation.' : 'Raw logs were not inspected because permission was denied.');
      return { message: lines.join('\n'), rawLogsInspected: granted };
    }

    lines.push('', 'Raw logs were not inspected because permission was not granted for this invocation.');
    return { message: lines.join('\n'), rawLogsInspected: false };
  }
}
