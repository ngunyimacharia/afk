import type { LinearProjectConfig } from './project-config.js';

export const LINEAR_API_KEY_ENV = 'LINEAR_API_KEY';

export type LinearWorkflowStateRole = 'ready' | 'running' | 'done' | 'handoff';

export interface LinearEntity {
  id: string;
  name: string;
}

export interface LinearTeam extends LinearEntity {
  key: string;
}

export interface LinearWorkflowState extends LinearEntity {
  teamId: string;
}

export interface LinearIssueLabel extends LinearEntity {}

export interface LinearIssueState extends LinearEntity {}

export interface LinearIssueSummary {
  id: string;
  identifier: string;
  url: string;
  title: string;
  branchName?: string | null;
  description?: string | null;
  state: LinearIssueState;
  labels: LinearIssueLabel[];
  relations?: LinearIssueRelation[];
  inverseRelations?: LinearIssueRelation[];
}

export interface LinearIssueRelation {
  type: string;
  relatedIssue: {
    id: string;
    identifier: string;
    parent?: { id: string } | null;
  };
}

export interface LinearParentIssue extends LinearIssueSummary {
  children: LinearIssueSummary[];
}

export interface LinearParentFeature {
  provider: 'linear';
  id: string;
  key: string;
  url: string;
  title: string;
  status: string;
  featureSlug: string;
  branchName?: string | null;
  workItems: LinearProviderWorkItem[];
}

export interface LinearProviderWorkItem {
  provider: 'linear';
  id: string;
  key: string;
  url: string;
  title: string;
  body: string;
  status: string;
  branchName?: string | null;
  parent: {
    id: string;
    key: string;
    url: string;
    title: string;
    featureSlug: string;
    branchName?: string | null;
  };
  labels: LinearIssueLabel[];
  afkLabel: LinearIssueLabel;
  dependsOn?: string[];
}

export interface LinearConfigClient {
  findTeam(identifier: string): Promise<LinearTeam | null>;
  findIssueLabel(teamId: string, name: string): Promise<LinearEntity | null>;
  findWorkflowState(teamId: string, identifier: string): Promise<LinearWorkflowState | null>;
}

export interface LinearDiscoveryClient {
  findAfkParentIssues(input: { teamId: string; labelId: string }): Promise<LinearParentIssue[]>;
}

interface LinearIssueGraphqlNode {
  id: string;
  identifier: string;
  url: string;
  title: string;
  branchName?: string | null;
  description?: string | null;
  state: LinearIssueState;
  labels: { nodes: LinearIssueLabel[] };
  relations?: { nodes: LinearIssueRelation[] };
  inverseRelations?: { nodes: LinearIssueRelation[] };
}

interface LinearParentIssueGraphqlNode extends LinearIssueGraphqlNode {
  children: { nodes: LinearIssueGraphqlNode[] };
}

export interface ResolvedLinearConfig {
  teamId: string;
  teamKey: string;
  labelId: string;
  workflowStateIds: Record<LinearWorkflowStateRole, string>;
}

export interface ResolveLinearConfigOptions {
  config?: LinearProjectConfig;
  env?: NodeJS.ProcessEnv;
  client?: LinearConfigClient;
}

export interface DiscoverLinearFeaturesOptions {
  resolvedConfig: ResolvedLinearConfig;
  client: LinearDiscoveryClient;
}

export class LinearStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinearStartupError';
  }
}

export class LinearGraphqlClient implements LinearConfigClient, LinearDiscoveryClient {
  constructor(
    private readonly apiKey: string,
    private readonly endpoint = 'https://api.linear.app/graphql',
  ) {}

  async findTeam(identifier: string): Promise<LinearTeam | null> {
    const result = await this.request<{
      teams: { nodes: LinearTeam[] };
    }>(
      `query AfkFindLinearTeam($identifier: String!) {
        teams(first: 1, filter: { or: [{ id: { eq: $identifier } }, { key: { eq: $identifier } }] }) {
          nodes { id key name }
        }
      }`,
      { identifier },
    );

    return result.teams.nodes[0] ?? null;
  }

  async findIssueLabel(teamId: string, name: string): Promise<LinearEntity | null> {
    const result = await this.request<{
      issueLabels: { nodes: LinearEntity[] };
    }>(
      `query AfkFindLinearIssueLabel($teamId: String!, $name: String!) {
        issueLabels(first: 1, filter: { team: { id: { eq: $teamId } }, name: { eq: $name } }) {
          nodes { id name }
        }
      }`,
      { teamId, name },
    );

    return result.issueLabels.nodes[0] ?? null;
  }

  async findWorkflowState(teamId: string, identifier: string): Promise<LinearWorkflowState | null> {
    const result = await this.request<{
      workflowStates: { nodes: LinearWorkflowState[] };
    }>(
      `query AfkFindLinearWorkflowState($teamId: String!, $identifier: String!) {
        workflowStates(first: 1, filter: { team: { id: { eq: $teamId } }, or: [{ id: { eq: $identifier } }, { name: { eq: $identifier } }] }) {
          nodes { id name team { id } }
        }
      }`,
      { teamId, identifier },
    );

    const state = result.workflowStates.nodes[0];
    return state ? { id: state.id, name: state.name, teamId } : null;
  }

  async findAfkParentIssues(input: { teamId: string; labelId: string }): Promise<LinearParentIssue[]> {
    try {
      return await this.findAfkParentIssuesWithBranchNames(input, true);
    } catch (error) {
      if (!isMissingBranchNameGraphqlError(error)) throw error;
      return this.findAfkParentIssuesWithBranchNames(input, false);
    }
  }

  private async findAfkParentIssuesWithBranchNames(
    input: { teamId: string; labelId: string },
    includeBranchNames: boolean,
  ): Promise<LinearParentIssue[]> {
    const branchNameField = includeBranchNames ? 'branchName' : '';
    const result = await this.request<{
      issues: {
        nodes: LinearParentIssueGraphqlNode[];
      };
    }>(
      `query AfkDiscoverLinearIssues($teamId: String!, $labelId: String!) {
        issues(
          first: 100
          filter: {
            team: { id: { eq: $teamId } }
            parent: { null: true }
            children: { some: { labels: { some: { id: { eq: $labelId } } } } }
          }
        ) {
          nodes {
            id
            identifier
            url
            title
            ${branchNameField}
            description
            state { id name }
            labels { nodes { id name } }
            children(first: 100, filter: { labels: { some: { id: { eq: $labelId } } } }) {
              nodes {
                id
                identifier
                url
                title
                ${branchNameField}
                description
                state { id name }
                labels { nodes { id name } }
                relations(first: 100) {
                  nodes {
                    type
                    relatedIssue { id identifier parent { id } }
                  }
                }
                inverseRelations(first: 100) {
                  nodes {
                    type
                    relatedIssue { id identifier parent { id } }
                  }
                }
              }
            }
          }
        }
      }`,
      input,
    );

    return result.issues.nodes.map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      title: issue.title,
      ...(issue.branchName ? { branchName: issue.branchName } : {}),
      description: issue.description,
      state: issue.state,
      labels: issue.labels.nodes,
      children: issue.children.nodes.map((child) => ({
        ...child,
        labels: child.labels.nodes,
        relations: child.relations?.nodes ?? [],
        inverseRelations: child.inverseRelations?.nodes ?? [],
      })),
    }));
  }

  private async request<T>(query: string, variables: Record<string, string>): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) throw new Error(`Linear GraphQL request failed with HTTP ${response.status}.`);

    const payload = (await response.json()) as { data?: T; errors?: { message?: string }[] };
    if (payload.errors?.length) {
      const details = payload.errors
        .map((error) => error.message)
        .filter(Boolean)
        .join('; ');
      throw new Error(`Linear GraphQL request failed: ${details || 'unknown error'}.`);
    }
    if (!payload.data) throw new Error('Linear GraphQL request failed: response did not include data.');

    return payload.data;
  }
}

function isMissingBranchNameGraphqlError(error: unknown): boolean {
  return (
    error instanceof Error && /branchName/.test(error.message) && /Cannot query field|Unknown field/.test(error.message)
  );
}

export async function resolveLinearConfig(options: ResolveLinearConfigOptions): Promise<ResolvedLinearConfig> {
  const env = options.env ?? process.env;
  const apiKey = env[LINEAR_API_KEY_ENV]?.trim();
  if (!apiKey) {
    throw new LinearStartupError(`Linear startup requires ${LINEAR_API_KEY_ENV} to be set.`);
  }

  const config = options.config;
  if (!config) {
    throw new LinearStartupError('Linear startup requires afk.json linear configuration.');
  }

  const client = options.client ?? new LinearGraphqlClient(apiKey);
  const team = await client.findTeam(config.team);
  if (!team) {
    throw new LinearStartupError(
      `Linear team "${config.team}" was not found. Set linear.team to an existing Linear team key or ID.`,
    );
  }

  const label = await client.findIssueLabel(team.id, config.afkLabel);
  if (!label) {
    throw new LinearStartupError(
      `Linear AFK label "${config.afkLabel}" was not found for team ${team.key}. Create the label in Linear or update linear.afkLabel.`,
    );
  }

  const workflowStateIds = {} as Record<LinearWorkflowStateRole, string>;
  for (const role of ['ready', 'running', 'done', 'handoff'] as const) {
    const configuredState = config.workflowStates[role];
    const state = await client.findWorkflowState(team.id, configuredState);
    if (!state) {
      throw new LinearStartupError(
        `Linear ${role} workflow state "${configuredState}" was not found for team ${team.key}. Update linear.workflowStates.${role} to an existing state name or ID.`,
      );
    }
    workflowStateIds[role] = state.id;
  }

  return {
    teamId: team.id,
    teamKey: team.key,
    labelId: label.id,
    workflowStateIds,
  };
}

export async function discoverLinearFeatures(options: DiscoverLinearFeaturesOptions): Promise<LinearParentFeature[]> {
  const parents = await options.client.findAfkParentIssues({
    teamId: options.resolvedConfig.teamId,
    labelId: options.resolvedConfig.labelId,
  });
  const terminalStateIds = new Set([
    options.resolvedConfig.workflowStateIds.done,
    options.resolvedConfig.workflowStateIds.handoff,
  ]);

  return parents.map((parent) => {
    const featureSlug = slugFromLinearKey(parent.identifier);
    const eligibleChildren = parent.children
      .filter((child) => child.labels.some((label) => label.id === options.resolvedConfig.labelId))
      .filter((child) => !terminalStateIds.has(child.state.id));
    const eligibleSiblingKeysById = new Map(eligibleChildren.map((child) => [child.id, child.identifier] as const));
    return {
      provider: 'linear',
      id: parent.id,
      key: parent.identifier,
      url: parent.url,
      title: parent.title,
      status: parent.state.name,
      featureSlug,
      ...(parent.branchName ? { branchName: parent.branchName } : {}),
      workItems: eligibleChildren.map((child) => {
        const afkLabel = child.labels.find((label) => label.id === options.resolvedConfig.labelId);
        if (!afkLabel) throw new Error(`Linear issue ${child.identifier} did not include the configured AFK label.`);
        const dependsOn = [
          ...new Set(
            [
              ...(child.relations ?? []).filter((relation) => isBlockedByRelation(relation.type)),
              ...(child.inverseRelations ?? []).filter((relation) => isBlocksRelation(relation.type)),
            ].flatMap((relation) => {
              const dependencyKey = eligibleSiblingKeysById.get(relation.relatedIssue.id);
              if (!dependencyKey || dependencyKey === child.identifier) return [];
              return [dependencyKey];
            }),
          ),
        ];
        return {
          provider: 'linear' as const,
          id: child.id,
          key: child.identifier,
          url: child.url,
          title: child.title,
          body: child.description ?? '',
          status: child.state.name,
          ...(child.branchName ? { branchName: child.branchName } : {}),
          parent: {
            id: parent.id,
            key: parent.identifier,
            url: parent.url,
            title: parent.title,
            featureSlug,
            ...(parent.branchName ? { branchName: parent.branchName } : {}),
          },
          labels: child.labels,
          afkLabel,
          dependsOn,
        };
      }),
    };
  });
}

function isBlockedByRelation(type: string): boolean {
  return (
    type
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, '') === 'blockedby'
  );
}

function isBlocksRelation(type: string): boolean {
  return (
    type
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, '') === 'blocks'
  );
}

export function slugFromLinearKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
