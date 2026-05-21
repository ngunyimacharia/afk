import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TicketRecord } from './types.js';

export type FeatureTicketState = 'ready' | 'blocked' | 'running' | 'complete' | 'failed' | 'terminal';

export interface FeatureExecutionIssue {
  feature: string;
  issue: string;
  reason: string;
}

export interface FeatureExecutionTicket {
  state: FeatureTicketState;
  dependsOn: string[];
  blockedBy: string[];
}

export interface FeatureExecutionGraph {
  feature: string;
  version: 1;
  generatedAt: string;
  waves: string[][];
  tickets: Record<string, FeatureExecutionTicket>;
}

const TERMINAL_STATUSES = new Set(['done', 'closed', 'complete', 'resolved', 'ready-for-human']);
const COMPLETE_STATUSES = new Set(['done', 'closed', 'complete', 'resolved']);

function normalizeStatus(status?: string): string | undefined {
  return status?.trim().toLowerCase();
}

function executionPath(repoRoot: string, feature: string): string {
  return path.join(repoRoot, '.scratch', feature, 'execution.json');
}

export function buildFeatureExecutionGraph(
  repoRoot: string,
  feature: string,
  tickets: TicketRecord[],
  persist = true,
): FeatureExecutionGraph {
  const byName = new Map(tickets.map((ticket) => [ticket.issueName, ticket] as const));
  const states = new Map<string, FeatureExecutionTicket>();
  const issues: FeatureExecutionIssue[] = [];

  for (const ticket of tickets) {
    const dependsOn = ticket.dependsOn ?? [];
    const status = normalizeStatus(ticket.status);
    const failedRuntime = existsSync(
      path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'sentinels', `${feature}-${ticket.issueName}.failed`),
    );
    const isTerminal = status ? TERMINAL_STATUSES.has(status) : false;
    const invalidDeps = dependsOn.filter((dep) => dep.includes('/') || dep.includes('\\') || dep.endsWith('.md'));
    const missingDeps = dependsOn.filter((dep) => !invalidDeps.includes(dep) && !byName.has(dep));
    const blockedBy = dependsOn.filter((dep) => {
      const dependency = byName.get(dep);
      if (!dependency) return false;
      return !COMPLETE_STATUSES.has(normalizeStatus(dependency.status) ?? '');
    });
    const state: FeatureTicketState = COMPLETE_STATUSES.has(status ?? '')
      ? 'complete'
      : failedRuntime
        ? 'failed'
        : isTerminal
          ? 'terminal'
          : missingDeps.length || invalidDeps.length || blockedBy.length
            ? 'blocked'
            : 'ready';
    for (const invalidDep of invalidDeps)
      issues.push({ feature, issue: ticket.issueName, reason: `invalid dependency reference: ${invalidDep}` });
    if (missingDeps.length) {
      issues.push({ feature, issue: ticket.issueName, reason: `missing dependency: ${missingDeps.join(', ')}` });
    }
    states.set(ticket.issueName, {
      state,
      dependsOn: [...dependsOn],
      blockedBy: [...new Set([...invalidDeps, ...missingDeps, ...blockedBy])],
    });
  }

  const cycle = findCycle(tickets);
  if (cycle.length) issues.push({ feature, issue: cycle[0], reason: `dependency cycle: ${cycle.join(' -> ')}` });

  if (issues.length) {
    throw new Error(issues.map((issue) => `${issue.feature}/${issue.issue}: ${issue.reason}`).join('\n'));
  }

  const waves = deriveWaves(tickets, states, byName);
  const graph: FeatureExecutionGraph = {
    feature,
    version: 1,
    generatedAt: new Date().toISOString(),
    waves,
    tickets: Object.fromEntries(states),
  };
  if (persist) writeFeatureExecutionGraph(repoRoot, feature, graph);
  return graph;
}

export function readFeatureExecutionGraph(repoRoot: string, feature: string): FeatureExecutionGraph | null {
  try {
    return JSON.parse(readFileSync(executionPath(repoRoot, feature), 'utf8')) as FeatureExecutionGraph;
  } catch {
    return null;
  }
}

export function writeFeatureExecutionGraph(repoRoot: string, feature: string, graph: FeatureExecutionGraph): void {
  const target = executionPath(repoRoot, feature);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(graph, null, 2)}\n`);
}

function deriveWaves(
  tickets: TicketRecord[],
  states: Map<string, FeatureExecutionTicket>,
  byName: Map<string, TicketRecord>,
): string[][] {
  const remaining = new Set(tickets.map((ticket) => ticket.issueName));
  const waves: string[][] = [];
  while (remaining.size) {
    const wave = [...remaining].filter((issue) => {
      const ticket = byName.get(issue);
      if (!ticket) return false;
      return (ticket.dependsOn ?? []).every((dep) => !remaining.has(dep));
    });
    if (!wave.length) break;
    waves.push(wave);
    for (const issue of wave) remaining.delete(issue);
  }
  return waves;
}

function findCycle(tickets: TicketRecord[]): string[] {
  const byName = new Map(tickets.map((ticket) => [ticket.issueName, ticket] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (issue: string): string[] => {
    if (visiting.has(issue)) return [...stack.slice(stack.indexOf(issue)), issue];
    if (visited.has(issue)) return [];
    visiting.add(issue);
    stack.push(issue);
    for (const dep of byName.get(issue)?.dependsOn ?? []) {
      if (!byName.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle.length) return cycle;
    }
    stack.pop();
    visiting.delete(issue);
    visited.add(issue);
    return [];
  };

  for (const ticket of tickets) {
    const cycle = visit(ticket.issueName);
    if (cycle.length) return cycle;
  }
  return [];
}
