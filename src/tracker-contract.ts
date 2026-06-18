import type { TicketRecord } from './types.js';

export type TrackerProviderKind = 'scratch' | 'linear' | 'jira';

export interface TrackerWorkItemKey {
  provider: TrackerProviderKind;
  id: string;
}

export interface TrackerProviderRef {
  key: TrackerWorkItemKey;
  displayId?: string;
  parent?: TrackerWorkItemKey;
  url?: string;
}

export interface TrackerWorkItemContent {
  feature: string;
  featureTitle?: string;
  issueName: string;
  label: string;
  status: string;
  executorAfk: boolean;
  dependsOn: string[];
  title: string;
  body: string;
  providerRef: TrackerProviderRef;
  url?: string;
  materializedFiles?: Partial<MaterializedTrackerFiles>;
  runResultInstructions?: string[];
}

export interface TrackerWorkItem extends TrackerWorkItemContent {
  key: TrackerWorkItemKey;
}

export interface TrackerCapabilities {
  list: boolean;
  get: boolean;
  create: boolean;
  update: boolean;
  appendComment: boolean;
  materialize: boolean;
  applyRunResult: boolean;
  summarize: boolean;
  cleanupIssues: boolean;
  parentChildIssues: boolean;
}

export interface TrackerCommentInput {
  body: string;
  createdAt?: string;
}

export interface TrackerRunResultUpdate {
  status: string;
  summary?: string;
  implementationStatus?: string;
  reviewStatus?: string;
  runStatus?: string;
  commitIds?: string[];
  logUrl?: string;
  error?: string;
}

export interface MaterializedTrackerFiles {
  ticketPath: string;
  scratchFeaturePath: string;
  featurePrdPath?: string;
  runtimeMetadataPath?: string;
  logPath?: string;
  runSummaryPath?: string;
}

export interface TrackerCreateInput {
  feature: string;
  issueName: string;
  title: string;
  body: string;
  status: string;
  dependsOn?: string[];
  parent?: TrackerWorkItemKey;
}

export interface TrackerUpdateInput {
  title?: string;
  body?: string;
  status?: string;
  dependsOn?: string[];
  parent?: TrackerWorkItemKey | null;
}

export interface TrackerProvider {
  kind: TrackerProviderKind;
  capabilities: TrackerCapabilities;
  list(feature?: string): Promise<TrackerWorkItem[]>;
  isEligible(item: TrackerWorkItem): boolean;
  get(key: TrackerWorkItemKey): Promise<TrackerWorkItem | null>;
  create(input: TrackerCreateInput): Promise<TrackerWorkItem>;
  update(key: TrackerWorkItemKey, input: TrackerUpdateInput): Promise<TrackerWorkItem>;
  appendComment(key: TrackerWorkItemKey, input: TrackerCommentInput): Promise<void>;
  materialize(key: TrackerWorkItemKey): Promise<MaterializedTrackerFiles>;
  applyRunResult(key: TrackerWorkItemKey, input: TrackerRunResultUpdate): Promise<void>;
}

export function normalizeTrackerWorkItemKey(key: TrackerWorkItemKey): string {
  const id = key.id.trim();
  if (!id) throw new Error('tracker work item key id is required');
  return `${key.provider}:${id.toLowerCase()}`;
}

export function trackerWorkItemToTicketRecord(
  item: TrackerWorkItem,
  path = item.materializedFiles?.ticketPath ?? '',
): TicketRecord {
  const provider = {
    kind: item.providerRef.key.provider,
    id: item.providerRef.key.id,
    ...(item.providerRef.displayId ? { displayId: item.providerRef.displayId } : {}),
    ...((item.providerRef.url ?? item.url) ? { url: item.providerRef.url ?? item.url } : {}),
    ...(item.materializedFiles ? { materializedFiles: item.materializedFiles } : {}),
    ...(item.runResultInstructions ? { runResultInstructions: item.runResultInstructions } : {}),
  };
  return {
    path,
    feature: item.feature,
    ...(item.featureTitle ? { featureTitle: item.featureTitle } : {}),
    issueName: item.issueName,
    label: item.label,
    status: item.status,
    executorAfk: item.executorAfk,
    dependsOn: item.dependsOn.map((dependency) => normalizeDependencyKey(item.feature, dependency)),
    provider,
  };
}

export function ticketRecordToTrackerWorkItem(ticket: TicketRecord, body = ''): TrackerWorkItem {
  const key = scratchTrackerWorkItemKey(ticket.feature, ticket.issueName);
  return {
    key,
    feature: ticket.feature,
    ...(ticket.featureTitle ? { featureTitle: ticket.featureTitle } : {}),
    issueName: ticket.issueName,
    label: ticket.label,
    status: ticket.status ?? '',
    executorAfk: ticket.executorAfk,
    dependsOn: ticket.dependsOn ?? [],
    title: ticket.label,
    body,
    providerRef: { key, displayId: ticket.issueName },
    materializedFiles: { ticketPath: ticket.path },
  };
}

export function scratchTrackerWorkItemKey(feature: string, issueName: string): TrackerWorkItemKey {
  return { provider: 'scratch', id: `${feature}/${issueName}` };
}

function normalizeDependencyKey(feature: string, dependency: string): string {
  const trimmed = dependency.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes('/')) return trimmed;
  return `${feature}/${trimmed}`;
}
