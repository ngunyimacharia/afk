import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { TicketRecord } from './types.js';

const TERMINAL_STATUSES = new Set(['done', 'closed', 'complete', 'resolved', 'ready-for-human']);

function normalize(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

function parseFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return {};
  return (YAML.parse(content.slice(4, end)) ?? {}) as Record<string, unknown>;
}

function parseLegacyStatus(content: string): string | undefined {
  const statusLine = content.match(/^Status:\s*(.+)$/im)?.[1]?.trim();
  if (statusLine) return statusLine;
  const headingMatch = content.match(/^##\s+Status\s*$([\s\S]*?)(?:^##\s+|Z)/im);
  const headingBody = headingMatch?.[1]?.trim();
  return headingBody ? headingBody.split(/\r?\n/)[0].trim() : undefined;
}

function readFrontmatterValue(frontmatter: Record<string, unknown>, key: string): unknown {
  const normalized = key.toLowerCase().replace(/[-_]/g, '');
  for (const [entryKey, value] of Object.entries(frontmatter)) {
    if (entryKey.toLowerCase().replace(/[-_]/g, '') === normalized) return value;
  }
  return undefined;
}

function parseDependsOn(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (typeof value === 'number') return [String(value)];
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => (typeof entry === 'string' || typeof entry === 'number' ? String(entry).trim() : ''))
    .filter((entry) => entry.length > 0);
}

function parseRawDependsOn(content: string): string[] | undefined {
  if (!content.startsWith('---\n')) return undefined;
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return undefined;
  const lines = content.slice(4, end).split(/\r?\n/);
  const index = lines.findIndex((line) => /^Depends-On\s*:/i.test(line));
  if (index === -1) return undefined;
  const first = lines[index].replace(/^Depends-On\s*:/i, '').trim();
  if (first && first !== '[]') return [first.replace(/^['"]|['"]$/g, '')];
  if (first === '[]') return [];
  const values: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (/^\S[^:]*:/.test(line)) break;
    const match = line.match(/^\s*-\s*(.+?)\s*$/);
    if (match?.[1]) values.push(match[1].replace(/^['"]|['"]$/g, ''));
  }
  return values;
}

export class TicketRepository {
  constructor(private readonly repoRoot: string) {}

  discoverTickets(): TicketRecord[] {
    const scratchRoot = path.join(this.repoRoot, '.scratch');
    if (!this.exists(scratchRoot)) return [];
    const features = readdirSync(scratchRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    return features.flatMap((featureDir) => {
      const issuesDir = path.join(scratchRoot, featureDir.name, 'issues');
      if (!this.exists(issuesDir)) return [];
      return readdirSync(issuesDir)
        .filter((file) => file.endsWith('.md'))
        .map((file) => this.readTicket(path.join(issuesDir, file), featureDir.name));
    });
  }

  readTicket(filePath: string, featureFallback?: string): TicketRecord {
    const content = readFileSync(filePath, 'utf8');
    const frontmatter = parseFrontmatter(content);
    const feature =
      (readFrontmatterValue(frontmatter, 'feature') as string | undefined) ??
      featureFallback ??
      path.basename(path.dirname(path.dirname(filePath)));
    const issueName = path.basename(filePath, '.md');
    const status = (readFrontmatterValue(frontmatter, 'status') as string | undefined) ?? parseLegacyStatus(content);
    const executorAfk =
      normalize(readFrontmatterValue(frontmatter, 'executor') as string | undefined) === 'afk' ||
      /(^|\n)Executor:\s*AFK\b/i.test(content);
    const dependsOn = parseRawDependsOn(content) ?? parseDependsOn(readFrontmatterValue(frontmatter, 'Depends-On'));
    return { path: filePath, feature, issueName, label: `${feature}/${issueName}`, status, executorAfk, dependsOn };
  }

  isEligible(ticket: TicketRecord): boolean {
    const status = normalize(ticket.status);
    if (!status) return ticket.executorAfk;
    if (TERMINAL_STATUSES.has(status)) return false;
    return status.includes('ready-for-agent') || ticket.executorAfk;
  }

  private exists(target: string): boolean {
    try {
      return statSync(target).isDirectory();
    } catch {
      return false;
    }
  }
}
