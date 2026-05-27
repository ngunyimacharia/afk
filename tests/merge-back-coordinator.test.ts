import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FakeAgentExecutionProvider } from '../src/agent-execution-provider.js';
import { MergeBackCoordinator } from '../src/merge-back-coordinator.js';
import { RuntimeStore } from '../src/runtime-store.js';

function initGitRepo(repoRoot: string): void {
  execFileSync('git', ['init'], { cwd: repoRoot, encoding: 'utf8' });
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@test.com', 'commit', '--allow-empty', '-m', 'initial'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
}

test('mergeFeatureBranchToBase merges cleanly without conflicts', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'merge-back-'));
  initGitRepo(repoRoot);

  // Create base branch file
  writeFileSync(path.join(repoRoot, 'base.txt'), 'base content');
  execFileSync('git', ['add', '.'], { cwd: repoRoot, encoding: 'utf8' });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@test.com', 'commit', '-m', 'base commit'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  // Create feature branch
  execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repoRoot, encoding: 'utf8' });
  writeFileSync(path.join(repoRoot, 'feature.txt'), 'feature content');
  execFileSync('git', ['add', '.'], { cwd: repoRoot, encoding: 'utf8' });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@test.com', 'commit', '-m', 'feature commit'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  // Go back to main
  execFileSync('git', ['checkout', 'main'], { cwd: repoRoot, encoding: 'utf8' });

  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: new FakeAgentExecutionProvider({ status: 'completed', sessionId: null, removable: true }),
    runtimeStore: new RuntimeStore({ repoRoot }),
  });

  const result = await coordinator.mergeFeatureBranchToBase({
    repoRoot,
    baseBranch: 'main',
    featureBranch: 'feature',
    feature: 'my-feature',
    model: { id: 'test/model' },
  });

  assert.equal(result.success, true);

  // Verify feature file exists on main
  const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  assert.equal(currentBranch, 'main');
  const featureFile = path.join(repoRoot, 'feature.txt');
  assert.ok(require('node:fs').existsSync(featureFile), 'feature file should be merged into base');
});

test('mergeFeatureBranchToBase resolves conflicts with agent', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'merge-back-conflict-'));
  initGitRepo(repoRoot);

  // Create base file
  writeFileSync(path.join(repoRoot, 'shared.txt'), 'base line\n');
  execFileSync('git', ['add', '.'], { cwd: repoRoot, encoding: 'utf8' });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@test.com', 'commit', '-m', 'base commit'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  // Create feature branch with conflicting change
  execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repoRoot, encoding: 'utf8' });
  writeFileSync(path.join(repoRoot, 'shared.txt'), 'feature line\n');
  execFileSync('git', ['add', '.'], { cwd: repoRoot, encoding: 'utf8' });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@test.com', 'commit', '-m', 'feature commit'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  // Go back to main and modify the same file
  execFileSync('git', ['checkout', 'main'], { cwd: repoRoot, encoding: 'utf8' });
  writeFileSync(path.join(repoRoot, 'shared.txt'), 'main line\n');
  execFileSync('git', ['add', '.'], { cwd: repoRoot, encoding: 'utf8' });
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@test.com', 'commit', '-m', 'main conflicting commit'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );

  let agentCalled = false;
  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: new FakeAgentExecutionProvider(() => {
      agentCalled = true;
      // Resolve the conflict by writing a merged version and staging it
      writeFileSync(path.join(repoRoot, 'shared.txt'), 'merged line\n');
      execFileSync('git', ['add', 'shared.txt'], { cwd: repoRoot, encoding: 'utf8' });
      return { status: 'completed', sessionId: null, removable: true };
    }),
    runtimeStore: new RuntimeStore({ repoRoot }),
  });

  const result = await coordinator.mergeFeatureBranchToBase({
    repoRoot,
    baseBranch: 'main',
    featureBranch: 'feature',
    feature: 'my-feature',
    model: { id: 'test/model' },
  });

  assert.equal(result.success, true);
  assert.ok(agentCalled, 'agent should have been called to resolve conflicts');

  const content = require('node:fs').readFileSync(path.join(repoRoot, 'shared.txt'), 'utf8');
  assert.equal(content, 'merged line\n');
});

test('mergeFeatureBranchToBase stashes uncommitted changes and restores them after merge', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'merge-back-stash-'));
  initGitRepo(repoRoot);

  // Create base file
  writeFileSync(path.join(repoRoot, 'base.txt'), 'base content');
  execFileSync('git', ['add', '.'], { cwd: repoRoot, encoding: 'utf8' });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@test.com', 'commit', '-m', 'base commit'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  // Create feature branch
  execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repoRoot, encoding: 'utf8' });
  writeFileSync(path.join(repoRoot, 'feature.txt'), 'feature content');
  execFileSync('git', ['add', '.'], { cwd: repoRoot, encoding: 'utf8' });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@test.com', 'commit', '-m', 'feature commit'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  // Go back to main and create uncommitted change
  execFileSync('git', ['checkout', 'main'], { cwd: repoRoot, encoding: 'utf8' });
  writeFileSync(path.join(repoRoot, 'uncommitted.txt'), 'uncommitted content');

  const coordinator = new MergeBackCoordinator({
    agentExecutionProvider: new FakeAgentExecutionProvider({ status: 'completed', sessionId: null, removable: true }),
    runtimeStore: new RuntimeStore({ repoRoot }),
  });

  const result = await coordinator.mergeFeatureBranchToBase({
    repoRoot,
    baseBranch: 'main',
    featureBranch: 'feature',
    feature: 'my-feature',
    model: { id: 'test/model' },
  });

  assert.equal(result.success, true);

  // Verify uncommitted file is restored
  const uncommittedFile = path.join(repoRoot, 'uncommitted.txt');
  assert.ok(require('node:fs').existsSync(uncommittedFile), 'uncommitted file should be restored after stash pop');
  const content = require('node:fs').readFileSync(uncommittedFile, 'utf8');
  assert.equal(content, 'uncommitted content');
});
