import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TicketRepository } from './ticket-repository.js';
import {
  type MaterializedTrackerFiles,
  scratchTrackerWorkItemKey,
  type TrackerCommentInput,
  type TrackerCreateInput,
  type TrackerProvider,
  type TrackerProviderKind,
  type TrackerRunResultUpdate,
  type TrackerUpdateInput,
  type TrackerWorkItem,
  type TrackerWorkItemKey,
  ticketRecordToTrackerWorkItem,
} from './tracker-contract.js';

export class ScratchTrackerProvider implements TrackerProvider {
  readonly kind = 'scratch' as const;
  readonly capabilities = {
    list: true,
    get: true,
    create: false,
    update: false,
    appendComment: false,
    materialize: true,
    applyRunResult: false,
    summarize: true,
    cleanupIssues: true,
    parentChildIssues: false,
  };

  private readonly repository: TicketRepository;

  constructor(
    private readonly repoRoot: string,
    repository?: TicketRepository,
  ) {
    this.repository = repository ?? new TicketRepository(repoRoot);
  }

  async list(feature?: string): Promise<TrackerWorkItem[]> {
    return this.repository
      .discoverTickets()
      .filter((ticket) => !feature || ticket.feature === feature)
      .map((ticket) => ticketRecordToTrackerWorkItem(ticket, readFileSync(ticket.path, 'utf8')));
  }

  async get(key: TrackerWorkItemKey): Promise<TrackerWorkItem | null> {
    this.assertScratchKey(key);
    const [feature, issueName] = this.parseScratchId(key.id);
    const ticketPath = this.ticketPath(feature, issueName);

    try {
      const ticket = this.repository.readTicket(ticketPath, feature);
      return ticketRecordToTrackerWorkItem(ticket, readFileSync(ticket.path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async create(_input: TrackerCreateInput): Promise<TrackerWorkItem> {
    throw new Error('scratch tracker provider does not support create');
  }

  async update(_key: TrackerWorkItemKey, _input: TrackerUpdateInput): Promise<TrackerWorkItem> {
    throw new Error('scratch tracker provider does not support update');
  }

  async appendComment(_key: TrackerWorkItemKey, _input: TrackerCommentInput): Promise<void> {
    throw new Error('scratch tracker provider does not support appendComment');
  }

  async materialize(key: TrackerWorkItemKey): Promise<MaterializedTrackerFiles> {
    this.assertScratchKey(key);
    const [feature, issueName] = this.parseScratchId(key.id);
    const ticketPath = this.ticketPath(feature, issueName);

    return {
      ticketPath,
      scratchFeaturePath: path.join(this.repoRoot, '.scratch', feature),
      featurePrdPath: path.join(this.repoRoot, '.scratch', feature, 'PRD.md'),
    };
  }

  async applyRunResult(_key: TrackerWorkItemKey, _input: TrackerRunResultUpdate): Promise<void> {
    throw new Error('scratch tracker provider does not support applyRunResult');
  }

  isEligible(item: TrackerWorkItem): boolean {
    return this.repository.isEligible({
      path: '',
      feature: item.feature,
      issueName: item.issueName,
      label: item.label,
      status: item.status,
      executorAfk: item.executorAfk,
      dependsOn: item.dependsOn,
    });
  }

  private assertScratchKey(key: TrackerWorkItemKey): void {
    if (key.provider !== this.kind) throw new Error(`scratch tracker provider cannot read ${key.provider} work items`);
  }

  private parseScratchId(id: string): [feature: string, issueName: string] {
    const [feature, issueName, ...extra] = id.split('/');
    if (!feature || !issueName || extra.length) throw new Error(`invalid scratch work item id: ${id}`);
    return [feature, issueName];
  }

  private ticketPath(feature: string, issueName: string): string {
    return path.join(this.repoRoot, '.scratch', feature, 'issues', `${issueName}.md`);
  }
}

export function createDefaultTrackerProvider(
  repoRoot: string,
  configuredProvider?: TrackerProviderKind,
): TrackerProvider {
  if (!configuredProvider || configuredProvider === 'scratch') return new ScratchTrackerProvider(repoRoot);
  throw new Error(`tracker provider is not configured: ${configuredProvider}`);
}

export { scratchTrackerWorkItemKey };
