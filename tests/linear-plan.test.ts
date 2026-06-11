import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runAfk } from '../src/cli.js';
import { createLinearPlan, createLinearProviderFromConfig, parseLinearPlanManifest } from '../src/linear-plan.js';
import type {
  LinearIssueDependencyInput,
  LinearIssueInput,
  LinearIssueResult,
  LinearProvider,
} from '../src/linear-provider.js';
import { GraphQLLinearProvider } from '../src/linear-provider.js';

class FakeLinearProvider implements LinearProvider {
  readonly issues: LinearIssueInput[] = [];
  readonly dependencies: LinearIssueDependencyInput[] = [];

  async createIssue(input: LinearIssueInput): Promise<LinearIssueResult> {
    this.issues.push(input);
    const key = `AFK-${this.issues.length}`;
    return { id: `issue-${this.issues.length}`, key, url: `https://linear.app/acme/issue/${key}` };
  }

  async createIssueDependency(input: LinearIssueDependencyInput): Promise<void> {
    this.dependencies.push(input);
  }
}

const validManifest = {
  parents: [
    {
      ref: 'parent',
      title: 'Parent issue',
      description: 'Parent description',
      subIssues: [
        { ref: 'api', title: 'Build API', description: 'API description' },
        { ref: 'ui', title: 'Build UI', description: 'UI description', dependsOn: ['api'] },
      ],
    },
  ],
};

test('parses a valid Linear plan manifest', () => {
  const result = parseLinearPlanManifest(validManifest);

  assert.deepEqual(result.errors, []);
  assert.equal(result.manifest?.parents[0]?.subIssues.length, 2);
  assert.deepEqual(result.manifest?.parents[0]?.subIssues[1]?.dependsOn, ['api']);
});

test('rejects invalid Linear plan manifests before provider mutation', async () => {
  const provider = new FakeLinearProvider();
  const result = parseLinearPlanManifest({
    parents: [{ ref: 'parent', title: 'Parent', description: 'Body', subIssues: [] }],
  });

  assert.equal(result.manifest, undefined);
  assert.match(result.errors.join('\n'), /subIssues must be a non-empty array/);
  assert.deepEqual(provider.issues, []);
});

test('requires Linear config before creating a provider', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-linear-config-'));
  writeFileSync(path.join(repoRoot, 'afk.json'), JSON.stringify({ testsEnabled: false, staticCheckCommands: [] }));

  const result = createLinearProviderFromConfig(repoRoot, {});

  assert.equal(result.provider, undefined);
  assert.match(result.errors.join('\n'), /Linear config missing/);
});

test('creates parent and sub-issues through the Linear provider boundary', async () => {
  const manifest = parseLinearPlanManifest(validManifest).manifest;
  assert.ok(manifest);
  const provider = new FakeLinearProvider();

  const result = await createLinearPlan({ manifest, teamId: 'team-1', provider });

  assert.deepEqual(
    provider.issues.map((issue) => ({ title: issue.title, parentId: issue.parentId })),
    [
      { title: 'Parent issue', parentId: undefined },
      { title: 'Build API', parentId: 'issue-1' },
      { title: 'Build UI', parentId: 'issue-1' },
    ],
  );
  assert.deepEqual(provider.dependencies, [{ issueId: 'issue-3', dependsOnIssueId: 'issue-2' }]);
  assert.deepEqual(result.parents[0]?.dependencyRelations, [
    {
      issueRef: 'ui',
      issue: { id: 'issue-3', key: 'AFK-3', url: 'https://linear.app/acme/issue/AFK-3' },
      dependsOnRef: 'api',
      dependsOnIssue: { id: 'issue-2', key: 'AFK-2', url: 'https://linear.app/acme/issue/AFK-2' },
      type: 'blocked-by',
    },
  ]);
  assert.deepEqual(result.dependencyOrder, ['api', 'ui']);
  assert.equal(result.parents[0]?.issue.key, 'AFK-1');
  assert.equal(result.parents[0]?.subIssues[1]?.issue.url, 'https://linear.app/acme/issue/AFK-3');
});

test('creates no dependency relations when sub-issues have no dependencies', async () => {
  const manifest = parseLinearPlanManifest({
    parents: [
      {
        ref: 'parent',
        title: 'Parent issue',
        description: 'Parent description',
        subIssues: [
          { ref: 'api', title: 'Build API', description: 'API description' },
          { ref: 'ui', title: 'Build UI', description: 'UI description' },
        ],
      },
    ],
  }).manifest;
  assert.ok(manifest);
  const provider = new FakeLinearProvider();

  const result = await createLinearPlan({ manifest, teamId: 'team-1', provider });

  assert.deepEqual(provider.dependencies, []);
  assert.deepEqual(result.parents[0]?.dependencyRelations, []);
});

test('creates blocked-by relations for multiple blockers', async () => {
  const manifest = parseLinearPlanManifest({
    parents: [
      {
        ref: 'parent',
        title: 'Parent issue',
        description: 'Parent description',
        subIssues: [
          { ref: 'api', title: 'Build API', description: 'API description' },
          { ref: 'db', title: 'Build DB', description: 'DB description' },
          { ref: 'ui', title: 'Build UI', description: 'UI description', dependsOn: ['api', 'db'] },
        ],
      },
    ],
  }).manifest;
  assert.ok(manifest);
  const provider = new FakeLinearProvider();

  const result = await createLinearPlan({ manifest, teamId: 'team-1', provider });

  assert.deepEqual(provider.dependencies, [
    { issueId: 'issue-4', dependsOnIssueId: 'issue-2' },
    { issueId: 'issue-4', dependsOnIssueId: 'issue-3' },
  ]);
  assert.deepEqual(
    result.parents[0]?.dependencyRelations.map((relation) => ({
      issueRef: relation.issueRef,
      dependsOnRef: relation.dependsOnRef,
      type: relation.type,
    })),
    [
      { issueRef: 'ui', dependsOnRef: 'api', type: 'blocked-by' },
      { issueRef: 'ui', dependsOnRef: 'db', type: 'blocked-by' },
    ],
  );
});

test('supports manifest-local aliases for dependency references', () => {
  const result = parseLinearPlanManifest({
    parents: [
      {
        ref: 'parent',
        title: 'Parent issue',
        description: 'Parent description',
        subIssues: [
          { ref: '01-api', aliases: ['api'], title: 'Build API', description: 'API description' },
          { ref: '02-ui', title: 'Build UI', description: 'UI description', dependsOn: ['api'] },
        ],
      },
    ],
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.manifest?.parents[0]?.subIssues[1]?.dependsOn, ['01-api']);
});

test('rejects missing and cross-parent dependency references before mutation', () => {
  const result = parseLinearPlanManifest({
    parents: [
      {
        ref: 'parent-a',
        title: 'Parent A',
        description: 'Parent A description',
        subIssues: [
          { ref: 'api', title: 'Build API', description: 'API description' },
          { ref: 'ui', title: 'Build UI', description: 'UI description', dependsOn: ['missing', 'other-api'] },
        ],
      },
      {
        ref: 'parent-b',
        title: 'Parent B',
        description: 'Parent B description',
        subIssues: [{ ref: 'other-api', title: 'Other API', description: 'Other API description' }],
      },
    ],
  });

  assert.equal(result.manifest, undefined);
  assert.match(result.errors.join('\n'), /ui depends on unknown sub-issue key or alias missing/);
  assert.match(result.errors.join('\n'), /belongs to parent parent-b/);
});

test('rejects cyclic dependency references before mutation', () => {
  const result = parseLinearPlanManifest({
    parents: [
      {
        ref: 'parent',
        title: 'Parent issue',
        description: 'Parent description',
        subIssues: [
          { ref: 'api', title: 'Build API', description: 'API description', dependsOn: ['ui'] },
          { ref: 'ui', title: 'Build UI', description: 'UI description', dependsOn: ['api'] },
        ],
      },
    ],
  });

  assert.equal(result.manifest, undefined);
  assert.match(result.errors.join('\n'), /dependency cycle detected in parent: api -> ui -> api/);
});

test('linear-plan command returns machine-readable created issue output', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-linear-command-'));
  const manifestPath = path.join(repoRoot, 'manifest.json');
  writeFileSync(
    path.join(repoRoot, 'afk.json'),
    JSON.stringify({ testsEnabled: false, staticCheckCommands: [], linear: { teamId: 'team-1' } }),
  );
  writeFileSync(manifestPath, JSON.stringify(validManifest));
  const originalArgv = process.argv;
  process.argv = ['bun', 'afk', 'linear-plan', manifestPath];
  try {
    const result = await runAfk(repoRoot, {
      env: { LINEAR_API_KEY: 'test-key' },
      linearProvider: new FakeLinearProvider(),
    });
    const output = JSON.parse(result.message) as {
      parents: Array<{
        issue: { key: string };
        subIssues: Array<{ issue: { url: string } }>;
        dependencyRelations: Array<{ issueRef: string; dependsOnRef: string; type: string }>;
      }>;
    };

    assert.equal(result.code, 0);
    assert.equal(output.parents[0]?.issue.key, 'AFK-1');
    assert.equal(output.parents[0]?.subIssues[1]?.issue.url, 'https://linear.app/acme/issue/AFK-3');
    assert.deepEqual(output.parents[0]?.dependencyRelations, [
      {
        issueRef: 'ui',
        issue: { id: 'issue-3', key: 'AFK-3', url: 'https://linear.app/acme/issue/AFK-3' },
        dependsOnRef: 'api',
        dependsOnIssue: { id: 'issue-2', key: 'AFK-2', url: 'https://linear.app/acme/issue/AFK-2' },
        type: 'blocked-by',
      },
    ]);
  } finally {
    process.argv = originalArgv;
  }
});

test('GraphQLLinearProvider rejects unsuccessful dependency relation responses', async () => {
  const provider = new GraphQLLinearProvider({
    apiKey: 'test-key',
    fetchImpl: async () =>
      new Response(JSON.stringify({ data: { issueRelationCreate: { success: false } } }), {
        status: 200,
        statusText: 'OK',
      }),
  });

  await assert.rejects(
    provider.createIssueDependency({ issueId: 'issue-2', dependsOnIssueId: 'issue-1' }),
    /issueRelationCreate did not create an issue relation/,
  );
});
