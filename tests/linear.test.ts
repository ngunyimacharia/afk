import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  LinearConfigClient,
  LinearDiscoveryClient,
  LinearEntity,
  LinearIssueLabel,
  LinearIssueState,
  LinearParentIssue,
  LinearTeam,
  LinearWorkflowState,
} from '../src/linear.js';
import { discoverLinearFeatures, LinearGraphqlClient, LinearStartupError, resolveLinearConfig } from '../src/linear.js';
import type { LinearProjectConfig } from '../src/project-config.js';

const validConfig: LinearProjectConfig = {
  team: 'ENG',
  afkLabel: 'AFK',
  workflowStates: {
    ready: 'Ready',
    running: 'In Progress',
    done: 'Done',
    handoff: 'Needs Handoff',
  },
};

test('resolves stable Linear config IDs', async () => {
  const resolved = await resolveLinearConfig({
    config: validConfig,
    env: { LINEAR_API_KEY: 'linear-key' },
    client: new FakeLinearClient(),
  });

  assert.deepEqual(resolved, {
    teamId: 'team-1',
    teamKey: 'ENG',
    labelId: 'label-1',
    workflowStateIds: {
      ready: 'state-ready',
      running: 'state-running',
      done: 'state-done',
      handoff: 'state-handoff',
    },
  });
});

test('fails Linear startup when credentials are absent', async () => {
  await assert.rejects(
    () => resolveLinearConfig({ config: validConfig, env: {}, client: new FakeLinearClient() }),
    (error) => error instanceof LinearStartupError && /LINEAR_API_KEY/.test(error.message),
  );
});

test('fails Linear startup when configured team cannot be resolved', async () => {
  await assert.rejects(
    () =>
      resolveLinearConfig({
        config: { ...validConfig, team: 'MISSING' },
        env: { LINEAR_API_KEY: 'linear-key' },
        client: new FakeLinearClient(),
      }),
    (error) => error instanceof LinearStartupError && /team "MISSING" was not found/.test(error.message),
  );
});

test('fails Linear startup when configured AFK label cannot be resolved', async () => {
  await assert.rejects(
    () =>
      resolveLinearConfig({
        config: { ...validConfig, afkLabel: 'Missing Label' },
        env: { LINEAR_API_KEY: 'linear-key' },
        client: new FakeLinearClient(),
      }),
    (error) => error instanceof LinearStartupError && /AFK label "Missing Label" was not found/.test(error.message),
  );
});

test('fails Linear startup when a workflow state cannot be resolved', async () => {
  await assert.rejects(
    () =>
      resolveLinearConfig({
        config: { ...validConfig, workflowStates: { ...validConfig.workflowStates, handoff: 'Missing Handoff' } },
        env: { LINEAR_API_KEY: 'linear-key' },
        client: new FakeLinearClient(),
      }),
    (error) =>
      error instanceof LinearStartupError &&
      /handoff workflow state "Missing Handoff" was not found/.test(error.message),
  );
});

test('discovers parent features with zero, one, and multiple eligible Linear sub-issues', async () => {
  const features = await discoverLinearFeatures({
    resolvedConfig: {
      teamId: 'team-1',
      teamKey: 'ENG',
      labelId: 'label-1',
      workflowStateIds: {
        ready: 'state-ready',
        running: 'state-running',
        done: 'state-done',
        handoff: 'state-handoff',
      },
    },
    client: new FakeLinearDiscoveryClient(),
  });

  assert.deepEqual(
    features.map((feature) => ({
      slug: feature.featureSlug,
      key: feature.key,
      workItemKeys: feature.workItems.map((item) => item.key),
    })),
    [
      { slug: 'eng-100', key: 'ENG-100', workItemKeys: [] },
      { slug: 'eng-200', key: 'ENG-200', workItemKeys: ['ENG-201'] },
      { slug: 'eng-300', key: 'ENG-300', workItemKeys: ['ENG-301', 'ENG-302'] },
    ],
  );
  assert.equal(features[1]?.workItems[0]?.id, 'child-one-eligible');
  assert.equal(features[1]?.workItems[0]?.url, 'https://linear.app/acme/issue/ENG-201/one-eligible');
  assert.equal(features[1]?.workItems[0]?.title, 'One eligible');
  assert.equal(features[1]?.workItems[0]?.body, 'Implement one eligible issue.');
  assert.equal(features[1]?.workItems[0]?.status, 'Ready');
  assert.deepEqual(features[1]?.workItems[0]?.parent, {
    id: 'parent-one',
    key: 'ENG-200',
    url: 'https://linear.app/acme/issue/ENG-200/one-parent',
    title: 'One parent',
    featureSlug: 'eng-200',
  });
  assert.deepEqual(features[1]?.workItems[0]?.afkLabel, { id: 'label-1', name: 'AFK' });
});

test('falls back when Linear GraphQL does not expose issue branchName', async () => {
  const originalFetch = globalThis.fetch;
  const queries: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
    const query = body.query ?? '';
    queries.push(query);

    if (queries.length === 1) {
      assert.match(query, /branchName/);
      return new Response(
        JSON.stringify({ errors: [{ message: 'Cannot query field "branchName" on type "Issue".' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    assert.doesNotMatch(query, /branchName/);
    return new Response(
      JSON.stringify({
        data: {
          issues: {
            nodes: [
              {
                id: 'parent-one',
                identifier: 'ENG-200',
                url: 'https://linear.app/acme/issue/ENG-200/one-parent',
                title: 'One parent',
                description: null,
                state: { id: 'state-ready', name: 'Ready' },
                labels: { nodes: [] },
                children: {
                  nodes: [
                    {
                      id: 'child-one-eligible',
                      identifier: 'ENG-201',
                      url: 'https://linear.app/acme/issue/ENG-201/one-eligible',
                      title: 'One eligible',
                      description: 'Implement one eligible issue.',
                      state: { id: 'state-ready', name: 'Ready' },
                      labels: { nodes: [{ id: 'label-1', name: 'AFK' }] },
                    },
                  ],
                },
              },
            ],
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const client = new LinearGraphqlClient('linear-key', 'https://linear.example/graphql');
    const issues = await client.findAfkParentIssues({ teamId: 'team-1', labelId: 'label-1' });

    assert.equal(queries.length, 2);
    assert.deepEqual(issues, [
      {
        id: 'parent-one',
        identifier: 'ENG-200',
        url: 'https://linear.app/acme/issue/ENG-200/one-parent',
        title: 'One parent',
        description: null,
        state: { id: 'state-ready', name: 'Ready' },
        labels: [],
        children: [
          {
            id: 'child-one-eligible',
            identifier: 'ENG-201',
            url: 'https://linear.app/acme/issue/ENG-201/one-eligible',
            title: 'One eligible',
            description: 'Implement one eligible issue.',
            state: { id: 'state-ready', name: 'Ready' },
            labels: [{ id: 'label-1', name: 'AFK' }],
          },
        ],
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

class FakeLinearClient implements LinearConfigClient {
  private readonly team: LinearTeam = { id: 'team-1', key: 'ENG', name: 'Engineering' };
  private readonly label: LinearEntity = { id: 'label-1', name: 'AFK' };
  private readonly states: LinearWorkflowState[] = [
    { id: 'state-ready', name: 'Ready', teamId: 'team-1' },
    { id: 'state-running', name: 'In Progress', teamId: 'team-1' },
    { id: 'state-done', name: 'Done', teamId: 'team-1' },
    { id: 'state-handoff', name: 'Needs Handoff', teamId: 'team-1' },
  ];

  async findTeam(identifier: string): Promise<LinearTeam | null> {
    return [this.team.id, this.team.key].includes(identifier) ? this.team : null;
  }

  async findIssueLabel(teamId: string, name: string): Promise<LinearEntity | null> {
    return teamId === this.team.id && name === this.label.name ? this.label : null;
  }

  async findWorkflowState(teamId: string, identifier: string): Promise<LinearWorkflowState | null> {
    return this.states.find((state) => state.teamId === teamId && [state.id, state.name].includes(identifier)) ?? null;
  }
}

class FakeLinearDiscoveryClient implements LinearDiscoveryClient {
  async findAfkParentIssues(input: { teamId: string; labelId: string }): Promise<LinearParentIssue[]> {
    assert.deepEqual(input, { teamId: 'team-1', labelId: 'label-1' });
    const afkLabel: LinearIssueLabel = { id: 'label-1', name: 'AFK' };
    const otherLabel: LinearIssueLabel = { id: 'label-2', name: 'Other' };
    const ready: LinearIssueState = { id: 'state-ready', name: 'Ready' };
    const done: LinearIssueState = { id: 'state-done', name: 'Done' };
    const handoff: LinearIssueState = { id: 'state-handoff', name: 'Needs Handoff' };

    return [
      parent('parent-zero', 'ENG-100', 'Zero parent', ready, [
        child('child-done', 'ENG-101', 'Done child', 'Already done.', done, [afkLabel]),
        child('child-handoff', 'ENG-102', 'Handoff child', 'Needs human.', handoff, [afkLabel]),
        child('child-unlabeled', 'ENG-103', 'Unlabeled child', 'Not AFK.', ready, [otherLabel]),
      ]),
      parent('parent-one', 'ENG-200', 'One parent', ready, [
        child('child-one-eligible', 'ENG-201', 'One eligible', 'Implement one eligible issue.', ready, [
          afkLabel,
          otherLabel,
        ]),
      ]),
      parent('parent-many', 'ENG-300', 'Many parent', ready, [
        child('child-many-a', 'ENG-301', 'Many A', null, ready, [afkLabel]),
        child('child-many-b', 'ENG-302', 'Many B', 'Second eligible issue.', ready, [afkLabel]),
      ]),
    ];
  }
}

function parent(
  id: string,
  identifier: string,
  title: string,
  state: LinearIssueState,
  children: LinearParentIssue['children'],
): LinearParentIssue {
  return {
    id,
    identifier,
    url: `https://linear.app/acme/issue/${identifier}/${title.toLowerCase().replaceAll(' ', '-')}`,
    title,
    description: null,
    state,
    labels: [],
    children,
  };
}

function child(
  id: string,
  identifier: string,
  title: string,
  description: string | null,
  state: LinearIssueState,
  labels: LinearIssueLabel[],
): LinearParentIssue['children'][number] {
  return {
    id,
    identifier,
    url: `https://linear.app/acme/issue/${identifier}/${title.toLowerCase().replaceAll(' ', '-')}`,
    title,
    description,
    state,
    labels,
  };
}
