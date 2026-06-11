export interface LinearIssueInput {
  teamId: string;
  title: string;
  description: string;
  parentId?: string;
}

export interface LinearIssueResult {
  id: string;
  key: string;
  url: string;
}

export interface LinearIssueDependencyInput {
  issueId: string;
  dependsOnIssueId: string;
}

export interface LinearProvider {
  createIssue(input: LinearIssueInput): Promise<LinearIssueResult>;
  createIssueDependency(input: LinearIssueDependencyInput): Promise<void>;
}

interface LinearGraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface IssueCreateResponse {
  issueCreate?: {
    success?: boolean;
    issue?: {
      id?: string;
      identifier?: string;
      url?: string;
    };
  };
}

interface IssueRelationCreateResponse {
  issueRelationCreate?: {
    success?: boolean;
  };
}

export class GraphQLLinearProvider implements LinearProvider {
  constructor(private readonly input: { apiKey: string; endpoint?: string; fetchImpl?: typeof fetch }) {}

  async createIssue(input: LinearIssueInput): Promise<LinearIssueResult> {
    const data = await this.request<IssueCreateResponse>(
      `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier url }
        }
      }`,
      {
        input: {
          teamId: input.teamId,
          title: input.title,
          description: input.description,
          ...(input.parentId ? { parentId: input.parentId } : {}),
        },
      },
    );
    const issue = data.issueCreate?.issue;
    if (!data.issueCreate?.success || !issue?.id || !issue.identifier || !issue.url) {
      throw new Error('Linear issueCreate did not return a created issue.');
    }
    return { id: issue.id, key: issue.identifier, url: issue.url };
  }

  async createIssueDependency(input: LinearIssueDependencyInput): Promise<void> {
    const data = await this.request<IssueRelationCreateResponse>(
      `mutation CreateIssueRelation($input: IssueRelationCreateInput!) {
        issueRelationCreate(input: $input) { success }
      }`,
      {
        input: {
          issueId: input.dependsOnIssueId,
          relatedIssueId: input.issueId,
          type: 'blocks',
        },
      },
    );
    if (!data.issueRelationCreate?.success) {
      throw new Error('Linear issueRelationCreate did not create an issue relation.');
    }
  }

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const fetchImpl = this.input.fetchImpl ?? fetch;
    const response = await fetchImpl(this.input.endpoint ?? 'https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        authorization: this.input.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`Linear GraphQL request failed: ${response.status} ${response.statusText}`);
    const body = (await response.json()) as LinearGraphQLResponse<T>;
    if (body.errors?.length) {
      throw new Error(`Linear GraphQL error: ${body.errors.map((error) => error.message ?? 'unknown').join('; ')}`);
    }
    if (!body.data) throw new Error('Linear GraphQL response did not include data.');
    return body.data;
  }
}
