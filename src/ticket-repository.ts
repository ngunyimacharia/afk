import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { TicketRecord } from './types.js';

const TERMINAL_STATUSES = new Set(['done', 'closed', 'complete', 'resolved', 'ready-for-human']);

function normalize(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

function parseFrontmatter(content: string): Record<string, string | undefined> {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return {};
  return (YAML.parse(content.slice(4, end)) ?? {}) as Record<string, string | undefined>;
}

function parseLegacyStatus(content: string): string | undefined {
  const statusLine = content.match(/^Status:\s*(.+)$/im)?.[1]?.trim();
  if (statusLine) return statusLine;
  const headingMatch = content.match(/^##\s+Status\s*$([\s\S]*?)(?:^##\s+|\Z)/im);
  const headingBody = headingMatch?.[1]?.trim();
  return headingBody ? headingBody.split(/\r?\n/)[0].trim() : undefined;
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
    const feature = frontmatter.feature ?? featureFallback ?? path.basename(path.dirname(path.dirname(filePath)));
    const issueName = path.basename(filePath, '.md');
    const status = frontmatter.status ?? parseLegacyStatus(content);
    const executorAfk = normalize(frontmatter.executor) === 'afk' || /(^|\n)Executor:\s*AFK\b/i.test(content);
    return { path: filePath, feature, issueName, label: `${feature}/${issueName}`, status, executorAfk };
  }

  isEligible(ticket: TicketRecord): boolean {
    const status = normalize(ticket.status);
    if (!status) return ticket.executorAfk;
    if (TERMINAL_STATUSES.has(status)) return false;
    return status.includes('ready-for-agent') || ticket.executorAfk;
  }

  private exists(target: string): boolean {
    try { return statSync(target).isDirectory(); } catch { return false; }
  }
}
