import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildFeatureExecutionGraph, readFeatureExecutionGraph, writeFeatureExecutionGraph, type FeatureExecutionGraph } from './feature-execution-graph.js';
import { TicketRepository } from './ticket-repository.js';

export class FeatureExecutionRefreshService {
  constructor(private readonly repoRoot: string) {}

  refresh(feature: string, options: { runningIssues?: Iterable<string> } = {}): FeatureExecutionGraph {
    const repository = new TicketRepository(this.repoRoot);
    const tickets = repository.discoverTickets().filter((ticket) => ticket.feature === feature);
    const graph = buildFeatureExecutionGraph(this.repoRoot, feature, tickets, false);
    for (const issue of options.runningIssues ?? []) {
      if (graph.tickets[issue]) graph.tickets[issue].state = 'running';
    }
    writeFeatureExecutionGraph(this.repoRoot, feature, graph);
    return graph;
  }

  load(feature: string): FeatureExecutionGraph | null {
    return readFeatureExecutionGraph(this.repoRoot, feature);
  }

  readRaw(feature: string): string | null {
    try {
      return readFileSync(path.join(this.repoRoot, '.scratch', feature, 'execution.json'), 'utf8');
    } catch {
      return null;
    }
  }
}
