import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { linearFeaturesToTicketRecords } from '../src/cli.js';
import { buildFeatureExecutionGraph } from '../src/feature-execution-graph.js';
import type {
  LinearConfigClient,
  LinearDiscoveryClient,
  LinearEntity,
  LinearIssueLabel,
  LinearIssueRelation,
  LinearIssueState,
  LinearParentIssue,
  LinearRunSyncClient,
  LinearTeam,
  LinearWorkflowState,
} from '../src/linear.js';
import {
  discoverLinearFeatures,
  LinearGraphqlClient,
  LinearStartupError,
  resolveLinearConfig,
  syncLinearRunStarted,
  syncLinearRunTerminal,
} from '../src/linear.js';
import { createLinearPlan } from '../src/linear-plan.js';
import type {
  LinearIssueDependencyInput,
  LinearIssueInput,
  LinearIssueResult,
  LinearProvider,
} from '../src/linear-provider.js';
import type { LinearProjectConfig } from '../src/project-config.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { SingleTicketRunner } from '../src/single-ticket-runner.js';
import type { RuntimeMetadataRecord } from '../src/types.js';

const validConfig: LinearProjectConfig = {
  team: 'ENG',
  afkLabel: 'AFK',
  labelName: 'AFK',
  projectId: 'project-1',
  workflowStates: {
    ready: 'Ready',
    running: 'In Progress',
    done: 'Done',
    handoff: 'Needs Handoff',
  },
  afkLabelName: 'AFK',
  readyStateName: 'Ready',
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
    projectId: 'project-1',
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

test('fails Linear startup when configured projectId is missing', async () => {
  await assert.rejects(
    () =>
      resolveLinearConfig({
        config: { ...validConfig, projectId: undefined },
        env: { LINEAR_API_KEY: 'linear-key' },
        client: new FakeLinearClient(),
      }),
    (error) => error instanceof LinearStartupError && /linear.projectId/.test(error.message),
  );
});

test('discovers only Linear parent issues inside the configured project', async () => {
  const features = await discoverLinearFeatures({
    resolvedConfig: {
      teamId: 'team-1',
      teamKey: 'ENG',
      labelId: 'label-1',
      projectId: 'project-1',
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
    features.map((feature) => feature.key),
    ['ENG-100', 'ENG-200', 'ENG-300'],
  );
});

test('discovers Linear parent issues in a different configured project', async () => {
  const afkLabel: LinearIssueLabel = { id: 'label-1', name: 'AFK' };
  const ready: LinearIssueState = { id: 'state-ready', name: 'Ready' };
  const features = await discoverLinearFeatures({
    resolvedConfig: {
      teamId: 'team-1',
      teamKey: 'ENG',
      labelId: 'label-1',
      projectId: 'project-2',
      workflowStateIds: {
        ready: 'state-ready',
        running: 'state-running',
        done: 'state-done',
        handoff: 'state-handoff',
      },
    },
    client: new StaticLinearDiscoveryClient(
      [
        parent('parent-project-1', 'ENG-100', 'Project 1 parent', ready, [
          child('child-project-1', 'ENG-101', 'Project 1 child', null, ready, [afkLabel]),
        ]),
        parent('parent-project-2', 'ENG-400', 'Project 2 parent', ready, [
          child('child-project-2', 'ENG-401', 'Project 2 child', null, ready, [afkLabel]),
        ]),
      ],
      new Map([
        ['parent-project-1', 'project-1'],
        ['parent-project-2', 'project-2'],
      ]),
    ),
  });

  assert.deepEqual(
    features.map((feature) => feature.key),
    ['ENG-400'],
  );
});

test('integrates config resolution, plan creation, and discovery with a shared projectId', async () => {
  const resolved = await resolveLinearConfig({
    config: validConfig,
    projectId: validConfig.projectId,
    env: { LINEAR_API_KEY: 'linear-key' },
    client: new FakeLinearClient(),
  });

  assert.equal(resolved.projectId, 'project-1');

  const planProvider = new FakeLinearPlanProvider();
  const plan = await createLinearPlan({
    manifest: {
      parents: [
        {
          ref: 'parent',
          title: 'Integration parent',
          description: 'Shared project context.',
          subIssues: [
            { ref: 'sub', title: 'Integration sub-issue', description: 'Verifies shared projectId context.' },
          ],
        },
      ],
    },
    teamId: resolved.teamId,
    provider: planProvider,
    setup: { afkLabelName: 'AFK', readyStateName: 'Ready' },
  });
  assert.equal(plan.parents[0]?.issue.key, 'AFK-1');
  assert.equal(plan.parents[0]?.subIssues[0]?.issue.key, 'AFK-2');

  const capturedInputs: { teamId: string; labelId: string; projectId: string }[] = [];
  const capturingClient: LinearDiscoveryClient = {
    async findAfkParentIssues(input) {
      capturedInputs.push(input);
      return [];
    },
  };

  await discoverLinearFeatures({ resolvedConfig: resolved, client: capturingClient });

  assert.deepEqual(capturedInputs, [{ teamId: 'team-1', labelId: 'label-1', projectId: 'project-1' }]);
});

test('discovers parent features with zero, one, and multiple eligible Linear sub-issues', async () => {
  const features = await discoverLinearFeatures({
    resolvedConfig: {
      teamId: 'team-1',
      teamKey: 'ENG',
      labelId: 'label-1',
      projectId: 'project-1',
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

test('maps Linear blocked-by sibling relations to AFK dependencies', async () => {
  const afkLabel: LinearIssueLabel = { id: 'label-1', name: 'AFK' };
  const ready: LinearIssueState = { id: 'state-ready', name: 'Ready' };
  const features = await discoverLinearFeatures({
    resolvedConfig: {
      teamId: 'team-1',
      teamKey: 'ENG',
      labelId: 'label-1',
      projectId: 'project-1',
      workflowStateIds: {
        ready: 'state-ready',
        running: 'state-running',
        done: 'state-done',
        handoff: 'state-handoff',
      },
    },
    client: new StaticLinearDiscoveryClient([
      parent('parent-relations', 'ENG-300', 'Relations parent', ready, [
        child('child-a', 'ENG-301', 'Foundation', null, ready, [afkLabel]),
        child('child-b', 'ENG-302', 'Dependent', null, ready, [afkLabel], [], [blocks('child-a', 'ENG-301')]),
        child(
          'child-c',
          'ENG-303',
          'Independent',
          null,
          ready,
          [afkLabel],
          [blockedBy('external-child', 'ENG-999', 'other-parent')],
        ),
      ]),
    ]),
  });

  const tickets = linearFeaturesToTicketRecords(features);
  assert.deepEqual(
    tickets.map((ticket) => ({ issueName: ticket.issueName, dependsOn: ticket.dependsOn })),
    [
      { issueName: 'eng-301', dependsOn: [] },
      { issueName: 'eng-302', dependsOn: ['eng-301'] },
      { issueName: 'eng-303', dependsOn: [] },
    ],
  );

  const graph = buildFeatureExecutionGraph(
    mkdtempSync(path.join(tmpdir(), 'afk-linear-graph-')),
    'eng-300',
    tickets,
    false,
  );
  assert.deepEqual(graph.waves, [['eng-301', 'eng-303'], ['eng-302']]);
});

test('surfaces cycles from Linear blocked-by relations through feature graph validation', async () => {
  const afkLabel: LinearIssueLabel = { id: 'label-1', name: 'AFK' };
  const ready: LinearIssueState = { id: 'state-ready', name: 'Ready' };
  const features = await discoverLinearFeatures({
    resolvedConfig: {
      teamId: 'team-1',
      teamKey: 'ENG',
      labelId: 'label-1',
      projectId: 'project-1',
      workflowStateIds: {
        ready: 'state-ready',
        running: 'state-running',
        done: 'state-done',
        handoff: 'state-handoff',
      },
    },
    client: new StaticLinearDiscoveryClient([
      parent('parent-cycle', 'ENG-400', 'Cycle parent', ready, [
        child('child-a', 'ENG-401', 'Cycle A', null, ready, [afkLabel], [blockedBy('child-b', 'ENG-402')]),
        child('child-b', 'ENG-402', 'Cycle B', null, ready, [afkLabel], [blockedBy('child-a', 'ENG-401')]),
      ]),
    ]),
  });

  const tickets = linearFeaturesToTicketRecords(features);
  assert.throws(
    () => buildFeatureExecutionGraph(mkdtempSync(path.join(tmpdir(), 'afk-linear-cycle-')), 'eng-400', tickets, false),
    /dependency cycle: eng-401 -> eng-402 -> eng-401/,
  );
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
      assert.match(query, /project:\s*\{\s*id:\s*\{\s*eq:\s*\$projectId\s*\}\s*\}/);
      return new Response(
        JSON.stringify({ errors: [{ message: 'Cannot query field "branchName" on type "Issue".' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    assert.doesNotMatch(query, /branchName/);
    assert.match(query, /project:\s*\{\s*id:\s*\{\s*eq:\s*\$projectId\s*\}\s*\}/);
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
                      relations: { nodes: [] },
                      inverseRelations: { nodes: [] },
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
    const issues = await client.findAfkParentIssues({ teamId: 'team-1', labelId: 'label-1', projectId: 'project-1' });

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
            relations: [],
            inverseRelations: [],
          },
        ],
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('syncs Linear-backed runs to the running workflow state', async () => {
  const client = new FakeLinearRunSyncClient();

  await syncLinearRunStarted({
    ticket: linearTicket(),
    resolvedConfig: resolvedLinearConfig(),
    client,
  });

  assert.deepEqual(client.stateUpdates, [{ issueId: 'child-one-eligible', stateId: 'state-running' }]);
});

test('syncs completed Linear-backed runs to done with AFK label and summary comment', async () => {
  const client = new FakeLinearRunSyncClient();

  await syncLinearRunTerminal({
    summary: {
      ticket: linearTicket(),
      metadata: runtimeMetadata('completed'),
      outcome: 'completed',
      nextAction: 'none; AFK run approved',
      reviewerNotes: 'Clean pass',
      tests: 'bun test tests/linear.test.ts',
      commits: ['abc1234 feat: sync linear'],
    },
    resolvedConfig: resolvedLinearConfig(),
    client,
  });

  assert.deepEqual(client.stateUpdates, [{ issueId: 'child-one-eligible', stateId: 'state-done' }]);
  assert.deepEqual(client.labelAdds, [{ issueId: 'child-one-eligible', labelId: 'label-1' }]);
  assert.match(client.comments[0]?.body ?? '', /Outcome: completed/);
  assert.match(client.comments[0]?.body ?? '', /Run ID: run-1/);
  assert.match(client.comments[0]?.body ?? '', /abc1234 feat: sync linear/);
});

test('syncs handoff Linear-backed runs to handoff with structured summary comment', async () => {
  const client = new FakeLinearRunSyncClient();

  await syncLinearRunTerminal({
    summary: {
      ticket: linearTicket(),
      metadata: runtimeMetadata('handoff'),
      outcome: 'handoff',
      nextAction: 'human review required',
      reviewerNotes: 'Reviewer needs a human decision',
      caveats: 'Budget cap reached',
    },
    resolvedConfig: resolvedLinearConfig(),
    client,
  });

  assert.deepEqual(client.stateUpdates, [{ issueId: 'child-one-eligible', stateId: 'state-handoff' }]);
  assert.deepEqual(client.labelAdds, [{ issueId: 'child-one-eligible', labelId: 'label-1' }]);
  assert.match(client.comments[0]?.body ?? '', /Outcome: handoff/);
  assert.match(client.comments[0]?.body ?? '', /Next action: human review required/);
});

test('records Linear sync failures without deleting local mirrors', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-linear-sync-failure-'));
  const store = new RuntimeStore({ repoRoot });
  const mirrorPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'linear-mirrors', 'eng-200-eng-201.md');
  const reviewerPromptPath = path.join(repoRoot, 'reviewer.md');
  mkdirSync(path.dirname(mirrorPath), { recursive: true });
  writeFileSync(mirrorPath, '# Linear mirror\n\n## AFK Summary\nDone\n');
  writeFileSync(reviewerPromptPath, 'Review the implementation.\n');
  const client = new FakeLinearRunSyncClient({ failOnStateUpdate: 2 });
  const runner = new SingleTicketRunner(
    store,
    {
      execute: async ({ invocationMode }) =>
        invocationMode === 'reviewer'
          ? { status: 'completed', output: [JSON.stringify({ done: true, summary: 'Clean pass', findings: [] })] }
          : { status: 'completed', output: ['implemented'] },
    },
    {},
    { resolvedConfig: resolvedLinearConfig(), client },
  );

  const result = await runner.launch({
    repoRoot,
    model: { id: 'model-1' },
    reviewerModel: { id: 'review-model' },
    reviewerPrompt: { id: 'reviewer-default', label: 'Reviewer default', path: reviewerPromptPath },
    tickets: [{ ...linearTicket(), path: mirrorPath, content: undefined }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'eng-200',
      defaultWorktreeName: 'eng-200',
      effectiveWorktreeName: 'eng-200',
      defaultBranchName: 'eng-200',
      effectiveBranchName: 'eng-200',
      worktreePath: repoRoot,
    },
  });

  assert.equal(result.outcome, 'completed');
  assert.equal(existsSync(mirrorPath), true);
  const metadata = JSON.parse(
    readFileSync(
      path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'eng-200-eng-201.json'),
      'utf8',
    ),
  ) as { LINEAR_SYNC_STATUS?: string; LINEAR_SYNC_FAILURES?: string[] };
  assert.equal(metadata.LINEAR_SYNC_STATUS, 'failed');
  assert.match(metadata.LINEAR_SYNC_FAILURES?.[0] ?? '', /synthetic Linear failure/);
});

test('syncs terminal Linear status when reviewer configuration is missing', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-linear-missing-reviewer-sync-'));
  const store = new RuntimeStore({ repoRoot });
  const mirrorPath = path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'linear-mirrors', 'eng-200-eng-201.md');
  mkdirSync(path.dirname(mirrorPath), { recursive: true });
  writeFileSync(mirrorPath, '# Linear mirror\n');
  const client = new FakeLinearRunSyncClient();
  const runner = new SingleTicketRunner(
    store,
    { execute: async () => ({ status: 'completed' }) },
    {},
    { resolvedConfig: resolvedLinearConfig(), client },
  );

  const result = await runner.launch({
    repoRoot,
    model: { id: 'model-1' },
    tickets: [{ ...linearTicket(), path: mirrorPath, content: undefined }],
    gitContext: { commits: [] },
    checkout: {
      featureSlug: 'eng-200',
      defaultWorktreeName: 'eng-200',
      effectiveWorktreeName: 'eng-200',
      defaultBranchName: 'eng-200',
      effectiveBranchName: 'eng-200',
      worktreePath: repoRoot,
    },
  });

  assert.equal(result.outcome, 'blocked');
  assert.deepEqual(client.stateUpdates, [
    { issueId: 'child-one-eligible', stateId: 'state-running' },
    { issueId: 'child-one-eligible', stateId: 'state-handoff' },
  ]);
  assert.match(client.comments[0]?.body ?? '', /Outcome: blocked/);
  assert.match(client.comments[0]?.body ?? '', /Next action: configure reviewer model and prompt/);
  const metadata = JSON.parse(
    readFileSync(
      path.join(repoRoot, '.scratch', '.opencode-afk-logs', 'runtime-metadata', 'eng-200-eng-201.json'),
      'utf8',
    ),
  ) as { LINEAR_SYNC_STATUS?: string };
  assert.equal(metadata.LINEAR_SYNC_STATUS, 'terminal-synced');
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
  async findAfkParentIssues(input: {
    teamId: string;
    labelId: string;
    projectId: string;
  }): Promise<LinearParentIssue[]> {
    assert.deepEqual(input, { teamId: 'team-1', labelId: 'label-1', projectId: 'project-1' });
    const afkLabel: LinearIssueLabel = { id: 'label-1', name: 'AFK' };
    const otherLabel: LinearIssueLabel = { id: 'label-2', name: 'Other' };
    const ready: LinearIssueState = { id: 'state-ready', name: 'Ready' };
    const done: LinearIssueState = { id: 'state-done', name: 'Done' };
    const handoff: LinearIssueState = { id: 'state-handoff', name: 'Needs Handoff' };

    const parents = [
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
      parent('parent-other-project', 'ENG-400', 'Other project parent', ready, [
        child('child-other-project', 'ENG-401', 'Other project child', 'Should be excluded.', ready, [afkLabel]),
      ]),
    ];
    const projectIdByParent = new Map<string, string>([
      ['parent-zero', 'project-1'],
      ['parent-one', 'project-1'],
      ['parent-many', 'project-1'],
      ['parent-other-project', 'project-2'],
    ]);
    return parents.filter((p) => projectIdByParent.get(p.id) === input.projectId);
  }
}

class FakeLinearRunSyncClient implements LinearRunSyncClient {
  readonly stateUpdates: { issueId: string; stateId: string }[] = [];
  readonly labelAdds: { issueId: string; labelId: string }[] = [];
  readonly comments: { issueId: string; body: string }[] = [];
  private stateUpdateCount = 0;

  constructor(private readonly options: { failOnStateUpdate?: number } = {}) {}

  async updateIssueState(issueId: string, stateId: string): Promise<void> {
    this.stateUpdateCount += 1;
    if (this.options.failOnStateUpdate === this.stateUpdateCount) {
      throw new Error('synthetic Linear failure');
    }
    this.stateUpdates.push({ issueId, stateId });
  }

  async addIssueLabel(issueId: string, labelId: string): Promise<void> {
    this.labelAdds.push({ issueId, labelId });
  }

  async createIssueComment(issueId: string, body: string): Promise<void> {
    this.comments.push({ issueId, body });
  }
}

class FakeLinearPlanProvider implements LinearProvider {
  private issueCounter = 0;

  async resolveIssueLabelId(): Promise<string | undefined> {
    return 'label-1';
  }

  async resolveWorkflowStateId(): Promise<string | undefined> {
    return 'state-ready';
  }

  async createIssue(_input: LinearIssueInput): Promise<LinearIssueResult> {
    this.issueCounter += 1;
    const key = `AFK-${this.issueCounter}`;
    return { id: `issue-${this.issueCounter}`, key, url: `https://linear.app/acme/issue/${key}` };
  }

  async createIssueDependency(_input: LinearIssueDependencyInput): Promise<void> {}
}

function resolvedLinearConfig() {
  return {
    teamId: 'team-1',
    teamKey: 'ENG',
    labelId: 'label-1',
    projectId: 'project-1',
    workflowStateIds: {
      ready: 'state-ready',
      running: 'state-running',
      done: 'state-done',
      handoff: 'state-handoff',
    },
  };
}

function linearTicket() {
  return {
    path: 'linear://ENG-201',
    feature: 'eng-200',
    issueName: 'eng-201',
    label: 'eng-200/eng-201',
    executorAfk: true,
    source: 'linear' as const,
    content: '# One eligible\n',
    providerIdentity: {
      provider: 'linear' as const,
      issueId: 'child-one-eligible',
      issueKey: 'ENG-201',
      issueUrl: 'https://linear.app/acme/issue/ENG-201/one-eligible',
      parentKey: 'ENG-200',
    },
  };
}

function runtimeMetadata(runStatus: 'completed' | 'handoff'): RuntimeMetadataRecord {
  return {
    RUN_ID: 'run-1',
    TICKET_PATH: 'linear://ENG-201',
    FEATURE_SLUG: 'eng-200',
    ISSUE_NAME: 'eng-201',
    LOG_PATH: '/tmp/afk.log',
    START_TIME: '2026-06-11T00:00:00.000Z',
    START_EPOCH: 0,
    DONE_SENTINEL_PATH: '/tmp/done',
    FAILED_SENTINEL_PATH: '/tmp/failed',
    STATUS: runStatus === 'completed' ? 'completed' : 'blocked',
    EXECUTION_PROVIDER: 'opencode',
    PROVIDER_SESSION_ID: null,
    PROVIDER_SESSION_REMOVABLE: false,
    INSPECTION_PROVIDER: null,
    INSPECTION_TARGET_IDENTIFIER: null,
    UNSAFE_REASON: null,
    RUN_STATUS: runStatus,
    FINAL_REVIEW_OUTCOME: runStatus === 'completed' ? 'approved' : 'needs-human',
    FINAL_REVIEW_REASON: runStatus === 'completed' ? 'Clean pass' : 'Needs human',
  };
}

class StaticLinearDiscoveryClient implements LinearDiscoveryClient {
  constructor(
    private readonly parents: LinearParentIssue[],
    private readonly projectIdByParent: Map<string, string> = new Map(),
  ) {}

  async findAfkParentIssues(input: {
    teamId: string;
    labelId: string;
    projectId: string;
  }): Promise<LinearParentIssue[]> {
    assert.equal(input.teamId, 'team-1');
    assert.equal(input.labelId, 'label-1');
    assert.equal(input.projectId.length > 0, true);
    if (this.projectIdByParent.size === 0) return this.parents;
    return this.parents.filter((p) => this.projectIdByParent.get(p.id) === input.projectId);
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
  relations: LinearIssueRelation[] = [],
  inverseRelations: LinearIssueRelation[] = [],
): LinearParentIssue['children'][number] {
  return {
    id,
    identifier,
    url: `https://linear.app/acme/issue/${identifier}/${title.toLowerCase().replaceAll(' ', '-')}`,
    title,
    description,
    state,
    labels,
    relations,
    inverseRelations,
  };
}

function blockedBy(id: string, identifier: string, parentId = 'parent-relations'): LinearIssueRelation {
  return {
    type: 'blocked_by',
    relatedIssue: {
      id,
      identifier,
      parent: { id: parentId },
    },
  };
}

function blocks(id: string, identifier: string, parentId = 'parent-relations'): LinearIssueRelation {
  return {
    type: 'blocks',
    relatedIssue: {
      id,
      identifier,
      parent: { id: parentId },
    },
  };
}
