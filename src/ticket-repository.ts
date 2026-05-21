import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { TicketRecord } from './types.js';

const TERMINAL_STATUSES = new Set(['done', 'closed', 'complete', 'resolved', 'ready-for-human']);

function normalize(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

function parseFrontmatter(content: string, filePath: string): Record<string, unknown> {
  if (/^Status:/im.test(content.split(/\r?\n/, 1)[0] ?? '')) {
    throw new Error(`${filePath}: legacy Status line before frontmatter is not supported; use YAML frontmatter status`);
  }
  if (!content.startsWith('---\n')) throw new Error(`${filePath}: missing YAML frontmatter`);
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) throw new Error(`${filePath}: unclosed YAML frontmatter`);
  const parsed = YAML.parse(content.slice(4, end)) ?? {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${filePath}: YAML frontmatter must be a mapping`);
  }
  return parsed as Record<string, unknown>;
}

function readFrontmatterValue(frontmatter: Record<string, unknown>, key: string): unknown {
  const normalized = key.toLowerCase().replace(/[-_]/g, '');
  for (const [entryKey, value] of Object.entries(frontmatter)) {
    if (entryKey.toLowerCase().replace(/[-_]/g, '') === normalized) return value;
  }
  return undefined;
}

function parseDependsOn(value: unknown, filePath: string): string[] {
  if (!value) return [];
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (typeof value === 'number') return [String(value)];
  if (!Array.isArray(value)) throw new Error(`${filePath}: Depends-On must be a string, number, or array`);

  return value
    .map((entry) => {
      if (typeof entry !== 'string' && typeof entry !== 'number') {
        throw new Error(`${filePath}: Depends-On entries must be strings or numbers`);
      }
      return String(entry).trim();
    })
    .filter((entry) => entry.length > 0);
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
    const frontmatter = parseFrontmatter(content, filePath);
    const feature =
      (readFrontmatterValue(frontmatter, 'feature') as string | undefined) ??
      featureFallback ??
      path.basename(path.dirname(path.dirname(filePath)));
    const issueName = path.basename(filePath, '.md');
    const statusValue = readFrontmatterValue(frontmatter, 'status');
    if (typeof statusValue !== 'string' || !statusValue.trim()) {
      throw new Error(`${filePath}: missing YAML frontmatter status`);
    }
    const status = statusValue.trim();
    const executorAfk = normalize(readFrontmatterValue(frontmatter, 'executor') as string | undefined) === 'afk';
    const dependsOn = parseDependsOn(readFrontmatterValue(frontmatter, 'Depends-On'), filePath);
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
