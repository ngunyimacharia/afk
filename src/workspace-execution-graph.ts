import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { FeatureExecutionRefreshService } from './feature-execution-refresh.js';

export type WorkspaceFeatureState = 'ready' | 'blocked' | 'running' | 'complete' | 'failed';

export interface WorkspaceExecutionFeature {
  state: WorkspaceFeatureState;
  dependsOnFeatures: string[];
  blockedByFeatures: string[];
  stackParent: string | null;
  blockingIssues: string[];
}

export interface WorkspaceExecutionGraph {
  version: 1;
  generatedAt: string;
  selectedFeatures: string[];
  concurrency: number;
  featureWaves: string[][];
  features: Record<string, WorkspaceExecutionFeature>;
}

export function parseFeatureDependencies(repoRoot: string, feature: string): string[] {
  const prdPath = path.join(repoRoot, '.scratch', feature, 'PRD.md');
  if (!existsSync(prdPath)) throw new Error(`Missing PRD for selected feature dependency chain: ${feature}`);
  const content = readFileSync(prdPath, 'utf8');
  if (!content.startsWith('---\n')) return [];
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return [];
  const frontmatter = (YAML.parse(content.slice(4, end)) ?? {}) as Record<string, unknown>;
  const value = frontmatter['Depends-On-Features'];
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

export function refreshWorkspaceExecutionGraph(
  repoRoot: string,
  selectedFeatures: string[],
  concurrency: number,
): WorkspaceExecutionGraph {
  const scratchRoot = path.join(repoRoot, '.scratch');
  const availableFeatures = new Set(
    existsSync(scratchRoot)
      ? readdirSync(scratchRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : [],
  );
  const allFeatures = expandSelectedFeatures(repoRoot, selectedFeatures, availableFeatures);
  const dependencies = new Map(
    allFeatures.map((feature) => [feature, parseFeatureDependencies(repoRoot, feature)] as const),
  );
  const cycle = findFeatureCycle(dependencies);
  if (cycle.length) throw new Error(`Feature dependency cycle: ${cycle.join(' -> ')}`);
  const refresh = new FeatureExecutionRefreshService(repoRoot);
  const features: Record<string, WorkspaceExecutionFeature> = {};
  for (const feature of allFeatures) {
    const graph = refresh.refresh(feature);
    const blockingIssues = Object.entries(graph.tickets)
      .filter(([, ticket]) => ticket.state !== 'complete' && ticket.state !== 'terminal')
      .map(([issue]) => issue);
    const complete = blockingIssues.length === 0;
    const deps = dependencies.get(feature) ?? [];
    const blockedByFeatures = deps.filter((dep) => {
      if (!selectedFeatures.includes(dep) && !isFeatureComplete(repoRoot, dep)) return true;
      return false;
    });
    features[feature] = {
      state: complete ? 'complete' : blockedByFeatures.length ? 'blocked' : 'ready',
      dependsOnFeatures: deps,
      blockedByFeatures,
      stackParent: deps.length === 1 ? deps[0] : null,
      blockingIssues,
    };
  }
  for (const feature of selectedFeatures) {
    for (const dependency of dependencies.get(feature) ?? []) {
      if (selectedFeatures.includes(dependency)) continue;
      const upstream = features[dependency];
      if (upstream && upstream.state !== 'complete') {
        throw new Error(
          `${feature} remains blocked by incomplete unselected upstream feature ${dependency}; blocking issues: ${upstream.blockingIssues.join(', ') || 'unknown'}`,
        );
      }
    }
  }
  const graph: WorkspaceExecutionGraph = {
    version: 1,
    generatedAt: new Date().toISOString(),
    selectedFeatures,
    concurrency,
    featureWaves: deriveFeatureWaves(dependencies),
    features,
  };
  const target = path.join(repoRoot, '.scratch', 'execution.json');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(graph, null, 2)}\n`);
  return graph;
}

export function orderSelectedFeaturesByWaves(graph: WorkspaceExecutionGraph): string[] {
  const selected = new Set(graph.selectedFeatures);
  return graph.featureWaves.flat().filter((feature) => selected.has(feature));
}

function expandSelectedFeatures(
  repoRoot: string,
  selectedFeatures: string[],
  availableFeatures: Set<string>,
): string[] {
  const result = new Set<string>();
  const visit = (feature: string): void => {
    if (!availableFeatures.has(feature)) throw new Error(`Missing feature dependency reference: ${feature}`);
    if (result.has(feature)) return;
    result.add(feature);
    for (const dependency of parseFeatureDependencies(repoRoot, feature)) visit(dependency);
  };
  for (const feature of selectedFeatures) visit(feature);
  return [...result];
}

function isFeatureComplete(repoRoot: string, feature: string): boolean {
  const graph = new FeatureExecutionRefreshService(repoRoot).refresh(feature);
  return Object.values(graph.tickets).every((ticket) => ticket.state === 'complete' || ticket.state === 'terminal');
}

function deriveFeatureWaves(dependencies: Map<string, string[]>): string[][] {
  const remaining = new Set(dependencies.keys());
  const waves: string[][] = [];
  while (remaining.size) {
    const wave = [...remaining].filter((feature) =>
      (dependencies.get(feature) ?? []).every((dep) => !remaining.has(dep)),
    );
    if (!wave.length) break;
    waves.push(wave);
    for (const feature of wave) remaining.delete(feature);
  }
  return waves;
}

function findFeatureCycle(dependencies: Map<string, string[]>): string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (feature: string): string[] => {
    if (visiting.has(feature)) return [...stack.slice(stack.indexOf(feature)), feature];
    if (visited.has(feature)) return [];
    visiting.add(feature);
    stack.push(feature);
    for (const dep of dependencies.get(feature) ?? []) {
      if (!dependencies.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle.length) return cycle;
    }
    stack.pop();
    visiting.delete(feature);
    visited.add(feature);
    return [];
  };
  for (const feature of dependencies.keys()) {
    const cycle = visit(feature);
    if (cycle.length) return cycle;
  }
  return [];
}
