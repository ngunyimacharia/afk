import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { RuntimeMetadataRecord } from './types.js';

const TERMINAL_STATUSES = new Set(['done', 'closed', 'complete', 'resolved']);

export interface CleanupPlannerInput {
  repoRoot: string;
}

export interface CleanupTarget {
  feature: string;
  issueName: string;
  issuePath: string;
  logPath?: string;
  metadataPath?: string;
  doneSentinelPath?: string;
  failedSentinelPath?: string;
  handoffSentinelPath?: string;
  reason: string;
}

export interface CleanupPlan {
  terminalTargets: CleanupTarget[];
  preservedIssues: string[];
  preservedArtifacts: string[];
  featureDirectoriesToDelete: string[];
  workspaceExecutionPath?: string;
}

function _readTerminalStatuses(): Set<string> {
  return TERMINAL_STATUSES;
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

function fileExists(target: string): boolean {
  try {
    return statSync(target).isFile();
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

function ticketLogPath(repoRoot: string, feature: string, issueName: string): string {
  return path.join(repoRoot, '.scratch', '.opencode-afk-logs', `${feature}-${issueName}.log`);
}

function ticketMetadataPath(repoRoot: string, feature: string, issueName: string): string {
  return path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', `${feature}-${issueName}.json`);
}

function ticketSentinelPath(
  repoRoot: string,
  feature: string,
  issueName: string,
  kind: 'done' | 'failed' | 'handoff',
): string {
  return path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'sentinels', `${feature}-${issueName}.${kind}`);
}

function readRuntimeMetadataRecord(repoRoot: string, feature: string, issueName: string): RuntimeMetadataRecord | null {
  const metadataPath = ticketMetadataPath(repoRoot, feature, issueName);
  if (!fileExists(metadataPath)) return null;
  try {
    return JSON.parse(readFileSync(metadataPath, 'utf8')) as RuntimeMetadataRecord;
  } catch {
    return null;
  }
}

function isTerminalTicketStatus(status: string | undefined, runtime: RuntimeMetadataRecord | null): boolean {
  const normalized = normalize(status);
  const isFrontmatterTerminal = TERMINAL_STATUSES.has(normalized);
  // Preserve handoff/manual-review work even if frontmatter looks terminal
  if (runtime?.RUN_STATUS === 'handoff') return false;
  if (runtime?.IMPLEMENTATION_STATUS === 'completed' && runtime?.REVIEW_STATUS === 'unavailable') return false;
  return isFrontmatterTerminal;
}

export class CleanupPlanner {
  constructor(private readonly input: CleanupPlannerInput) {}

  buildPlan(): CleanupPlan {
    const scratchRoot = path.join(this.input.repoRoot, '.scratch');
    if (!exists(scratchRoot)) {
      return { terminalTargets: [], preservedIssues: [], preservedArtifacts: [], featureDirectoriesToDelete: [] };
    }
    const features = readdirSync(scratchRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const terminalTargets: CleanupTarget[] = [];
    const preservedIssues: string[] = [];
    const preservedArtifacts: string[] = [];
    const featureDirectoriesToDelete: string[] = [];

    for (const featureDir of features) {
      const issuesDir = path.join(scratchRoot, featureDir.name, 'issues');
      if (!exists(issuesDir)) continue;
      const issueFiles = readdirSync(issuesDir).filter((file) => file.endsWith('.md'));
      let hasPending = false;
      for (const file of issueFiles) {
        const issuePath = path.join(issuesDir, file);
        const content = readFileSync(issuePath, 'utf8');
        const frontmatter = parseFrontmatter(content);
        const status = parseStatus(content, frontmatter);
        const issueName = path.basename(file, '.md');
        const runtime = readRuntimeMetadataRecord(this.input.repoRoot, featureDir.name, issueName);
        const isTerminal = isTerminalTicketStatus(status, runtime);
        if (isTerminal) {
          terminalTargets.push({
            feature: featureDir.name,
            issueName,
            issuePath,
            logPath: fileExists(ticketLogPath(this.input.repoRoot, featureDir.name, issueName))
              ? ticketLogPath(this.input.repoRoot, featureDir.name, issueName)
              : undefined,
            metadataPath: fileExists(ticketMetadataPath(this.input.repoRoot, featureDir.name, issueName))
              ? ticketMetadataPath(this.input.repoRoot, featureDir.name, issueName)
              : undefined,
            doneSentinelPath: fileExists(ticketSentinelPath(this.input.repoRoot, featureDir.name, issueName, 'done'))
              ? ticketSentinelPath(this.input.repoRoot, featureDir.name, issueName, 'done')
              : undefined,
            failedSentinelPath: fileExists(
              ticketSentinelPath(this.input.repoRoot, featureDir.name, issueName, 'failed'),
            )
              ? ticketSentinelPath(this.input.repoRoot, featureDir.name, issueName, 'failed')
              : undefined,
            handoffSentinelPath: fileExists(
              ticketSentinelPath(this.input.repoRoot, featureDir.name, issueName, 'handoff'),
            )
              ? ticketSentinelPath(this.input.repoRoot, featureDir.name, issueName, 'handoff')
              : undefined,
            reason: `terminal status: ${status}`,
          });
        } else {
          hasPending = true;
          preservedIssues.push(issuePath);
        }
      }
      if (!hasPending && issueFiles.length > 0)
        featureDirectoriesToDelete.push(path.join(scratchRoot, featureDir.name));
    }

    for (const target of terminalTargets) {
      if (target.logPath) preservedArtifacts.push(target.logPath);
      if (target.metadataPath) preservedArtifacts.push(target.metadataPath);
      if (target.doneSentinelPath) preservedArtifacts.push(target.doneSentinelPath);
      if (target.failedSentinelPath) preservedArtifacts.push(target.failedSentinelPath);
      if (target.handoffSentinelPath) preservedArtifacts.push(target.handoffSentinelPath);
    }

    const workspaceExecutionPath = fileExists(path.join(scratchRoot, 'execution.json'))
      ? path.join(scratchRoot, 'execution.json')
      : undefined;
    return { terminalTargets, preservedIssues, preservedArtifacts, featureDirectoriesToDelete, workspaceExecutionPath };
  }
}

export class CleanupExecutor {
  execute(plan: CleanupPlan): { deleted: string[] } {
    const deleted: string[] = [];
    for (const target of plan.terminalTargets) {
      for (const filePath of [
        target.issuePath,
        target.logPath,
        target.metadataPath,
        target.doneSentinelPath,
        target.failedSentinelPath,
        target.handoffSentinelPath,
      ].filter((value): value is string => Boolean(value))) {
        try {
          rmSync(filePath, { force: true, recursive: false });
          deleted.push(filePath);
        } catch {}
      }
    }
    for (const featureDir of plan.featureDirectoriesToDelete) {
      try {
        rmSync(featureDir, { force: true, recursive: true });
        deleted.push(featureDir);
      } catch {}
    }
    if (plan.workspaceExecutionPath) {
      try {
        rmSync(plan.workspaceExecutionPath, { force: true, recursive: false });
        deleted.push(plan.workspaceExecutionPath);
      } catch {}
    }
    return { deleted };
  }
}
