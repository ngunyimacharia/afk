import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentExecutionRequest } from '../src/agent-execution-provider.js';
import { FakeAgentExecutionProvider } from '../src/agent-execution-provider.js';
import { resolveExecutable } from '../src/executable-resolution.js';
import { createPullRequestsForCompletedFeatures, type FeaturePrCreationInput } from '../src/feature-pr-creation.js';
import type { GithubPrTemplateDiscoveryResult } from '../src/github-pr-template-discovery.js';
import type { SchedulerTicketResult } from '../src/scheduler.js';
import type { AgentExecutionProgressEvent, AgentExecutionResult, CheckoutContext } from '../src/types.js';
import { mkRepoLocalTempDir } from './helpers/temp-repo.js';

const GIT_PATH = resolveExecutable('git');

function git(repoRoot: string, args: string[]): string {
  return execFileSync(GIT_PATH, args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function createRepo(prefix: string): string {
  const repoRoot = mkRepoLocalTempDir(prefix);
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  writeFileSync(path.join(repoRoot, 'README.md'), 'test\n');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-m', 'initial']);
  return repoRoot;
}

function createFeatureWorktree(repoRoot: string, feature: string): string {
  const branchName = `afk/${feature}`;
  git(repoRoot, ['branch', branchName]);
  const worktreePath = path.join(repoRoot, '.worktree', feature);
  git(repoRoot, ['worktree', 'add', worktreePath, branchName]);
  return worktreePath;
}

function checkout(feature: string, branchName: string, worktreePath: string): CheckoutContext {
  return {
    featureSlug: feature,
    defaultWorktreeName: feature,
    effectiveWorktreeName: feature,
    defaultBranchName: branchName,
    effectiveBranchName: branchName,
    branchNameSource: 'fallback',
    worktreePath,
  };
}

const NO_TEMPLATE: GithubPrTemplateDiscoveryResult = { kind: 'none', candidatePaths: [] };

function baseInput(overrides: Partial<FeaturePrCreationInput>): FeaturePrCreationInput {
  return {
    repoRoot: '/tmp/repo',
    baseBranch: 'main',
    features: [],
    checkoutsByFeature: {},
    agentExecutionProvider: new FakeAgentExecutionProvider({ status: 'completed', output: [] }),
    model: { id: 'model-1' },
    discoverTemplates: () => NO_TEMPLATE,
    remoteBranchExists: () => false,
    cleanupAfterCreate: false,
    ...overrides,
  };
}

test('createPullRequestsForCompletedFeatures returns the PR URL on success', async () => {
  const progress: AgentExecutionProgressEvent[] = [];
  const results = await createPullRequestsForCompletedFeatures(
    baseInput({
      features: ['feat-a'],
      checkoutsByFeature: { 'feat-a': checkout('feat-a', 'afk/feat-a', '/tmp/repo/.worktree/feat-a') },
      agentExecutionProvider: new FakeAgentExecutionProvider({
        status: 'completed',
        output: ['working...', '{"done": true, "prUrl": "https://github.com/o/r/pull/7", "summary": "adds feat-a"}'],
      }),
      onProgress: (event) => progress.push(event),
    }),
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]?.success, true);
  assert.equal(results[0]?.prUrl, 'https://github.com/o/r/pull/7');
  assert.equal(results[0]?.summary, 'adds feat-a');
  assert.ok(progress.some((event) => event.message.includes('https://github.com/o/r/pull/7')));
});

test('createPullRequestsForCompletedFeatures reports malformed agent output as failure', async () => {
  const results = await createPullRequestsForCompletedFeatures(
    baseInput({
      features: ['feat-a'],
      checkoutsByFeature: { 'feat-a': checkout('feat-a', 'afk/feat-a', '/tmp/repo/.worktree/feat-a') },
      agentExecutionProvider: new FakeAgentExecutionProvider({
        status: 'completed',
        output: ['I created the PR, trust me.'],
      }),
    }),
  );

  assert.equal(results[0]?.success, false);
  assert.match(results[0]?.reason ?? '', /malformed/);
});

test('createPullRequestsForCompletedFeatures reports done:false reason', async () => {
  const results = await createPullRequestsForCompletedFeatures(
    baseInput({
      features: ['feat-a'],
      checkoutsByFeature: { 'feat-a': checkout('feat-a', 'afk/feat-a', '/tmp/repo/.worktree/feat-a') },
      agentExecutionProvider: new FakeAgentExecutionProvider({
        status: 'completed',
        output: ['{"done": false, "reason": "gh is not authenticated"}'],
      }),
    }),
  );

  assert.equal(results[0]?.success, false);
  assert.equal(results[0]?.reason, 'gh is not authenticated');
});

test('createPullRequestsForCompletedFeatures treats success without URL as failure', async () => {
  const results = await createPullRequestsForCompletedFeatures(
    baseInput({
      features: ['feat-a'],
      checkoutsByFeature: { 'feat-a': checkout('feat-a', 'afk/feat-a', '/tmp/repo/.worktree/feat-a') },
      agentExecutionProvider: new FakeAgentExecutionProvider({
        status: 'completed',
        output: ['{"done": true, "summary": "no url here"}'],
      }),
    }),
  );

  assert.equal(results[0]?.success, false);
  assert.match(results[0]?.reason ?? '', /without a pull request URL/);
});

test('createPullRequestsForCompletedFeatures continues after a feature failure', async () => {
  const provider = new FakeAgentExecutionProvider((request: AgentExecutionRequest): AgentExecutionResult => {
    if (request.prompt.includes('Feature: feat-a')) {
      return { status: 'failed', unsafeReason: 'agent crashed' };
    }
    return {
      status: 'completed',
      output: ['{"done": true, "prUrl": "https://github.com/o/r/pull/9", "summary": "feat-b"}'],
    };
  });

  const results = await createPullRequestsForCompletedFeatures(
    baseInput({
      features: ['feat-a', 'feat-b'],
      checkoutsByFeature: {
        'feat-a': checkout('feat-a', 'afk/feat-a', '/tmp/repo/.worktree/feat-a'),
        'feat-b': checkout('feat-b', 'afk/feat-b', '/tmp/repo/.worktree/feat-b'),
      },
      agentExecutionProvider: provider,
    }),
  );

  assert.equal(results.length, 2);
  assert.equal(results[0]?.feature, 'feat-a');
  assert.equal(results[0]?.success, false);
  assert.equal(results[0]?.reason, 'agent crashed');
  assert.equal(results[1]?.feature, 'feat-b');
  assert.equal(results[1]?.success, true);
  assert.equal(results[1]?.prUrl, 'https://github.com/o/r/pull/9');
});

test('createPullRequestsForCompletedFeatures passes template and completed tickets into the prompt', async () => {
  let capturedPrompt = '';
  const ticketResults: SchedulerTicketResult[] = [
    {
      ticket: { path: '/tmp/a-1.md', feature: 'feat-a', issueName: '001', label: 'feat-a/001', executorAfk: true },
      outcome: 'completed',
      message: '',
    },
  ];

  await createPullRequestsForCompletedFeatures(
    baseInput({
      features: ['feat-a'],
      checkoutsByFeature: { 'feat-a': checkout('feat-a', 'afk/feat-a', '/tmp/repo/.worktree/feat-a') },
      ticketResults,
      discoverTemplates: () => ({
        kind: 'selected',
        path: '.github/pull_request_template.md',
        content: 'TEMPLATE BODY MARKER',
        candidatePaths: ['.github/pull_request_template.md'],
      }),
      agentExecutionProvider: new FakeAgentExecutionProvider((request) => {
        capturedPrompt = request.prompt;
        return {
          status: 'completed',
          output: ['{"done": true, "prUrl": "https://github.com/o/r/pull/1"}'],
        };
      }),
    }),
  );

  assert.match(capturedPrompt, /TEMPLATE BODY MARKER/);
  assert.match(capturedPrompt, /\.github\/pull_request_template\.md/);
  assert.match(capturedPrompt, /feat-a\/001/);
  assert.match(capturedPrompt, /gh pr create/);
});

test('createPullRequestsForCompletedFeatures uses the pull-request invocation mode', async () => {
  let capturedMode: string | undefined;
  await createPullRequestsForCompletedFeatures(
    baseInput({
      features: ['feat-a'],
      checkoutsByFeature: { 'feat-a': checkout('feat-a', 'afk/feat-a', '/tmp/repo/.worktree/feat-a') },
      agentExecutionProvider: new FakeAgentExecutionProvider((request) => {
        capturedMode = request.invocationMode;
        return { status: 'completed', output: ['{"done": true, "prUrl": "https://github.com/o/r/pull/1"}'] };
      }),
    }),
  );

  assert.equal(capturedMode, 'pull-request');
});

test('createPullRequestsForCompletedFeatures skips cleanup when the remote branch is missing', async () => {
  const repoRoot = createRepo('feature-pr-cleanup-skip-');
  const worktreePath = createFeatureWorktree(repoRoot, 'feat-a');

  const results = await createPullRequestsForCompletedFeatures(
    baseInput({
      repoRoot,
      features: ['feat-a'],
      checkoutsByFeature: { 'feat-a': checkout('feat-a', 'afk/feat-a', worktreePath) },
      agentExecutionProvider: new FakeAgentExecutionProvider({
        status: 'completed',
        output: ['{"done": true, "prUrl": "https://github.com/o/r/pull/3"}'],
      }),
      cleanupAfterCreate: true,
      remoteBranchExists: () => false,
    }),
  );

  assert.equal(results[0]?.success, true);
  assert.equal(results[0]?.deletedWorktree, false);
  assert.equal(results[0]?.deletedBranch, false);
  assert.match(results[0]?.warning ?? '', /remote branch .* not found/);
  assert.equal(existsSync(worktreePath), true);
});

test('createPullRequestsForCompletedFeatures cleans up local branch when remote exists and cleanup is safe', async () => {
  const repoRoot = createRepo('feature-pr-cleanup-ok-');
  const worktreePath = createFeatureWorktree(repoRoot, 'feat-a');

  const results = await createPullRequestsForCompletedFeatures(
    baseInput({
      repoRoot,
      features: ['feat-a'],
      checkoutsByFeature: { 'feat-a': checkout('feat-a', 'afk/feat-a', worktreePath) },
      agentExecutionProvider: new FakeAgentExecutionProvider({
        status: 'completed',
        output: ['{"done": true, "prUrl": "https://github.com/o/r/pull/4"}'],
      }),
      cleanupAfterCreate: true,
      remoteBranchExists: () => true,
    }),
  );

  assert.equal(results[0]?.success, true);
  assert.equal(results[0]?.deletedWorktree, true);
  assert.equal(results[0]?.deletedBranch, true);
  assert.equal(existsSync(worktreePath), false);
  assert.equal(git(repoRoot, ['branch', '--list', 'afk/feat-a']), '');
});

test('createPullRequestsForCompletedFeatures skips features whose branch equals base', async () => {
  const results = await createPullRequestsForCompletedFeatures(
    baseInput({
      features: ['feat-a'],
      checkoutsByFeature: { 'feat-a': checkout('feat-a', 'main', '/tmp/repo/.worktree/feat-a') },
    }),
  );

  assert.equal(results[0]?.success, false);
  assert.match(results[0]?.reason ?? '', /matches base branch/);
});
