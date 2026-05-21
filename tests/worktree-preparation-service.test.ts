import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildPrompt } from '../src/prompt-builder.js';
import { buildWorktreeReadiness, detectTestSuite, type ReadinessCommandExecutor } from '../src/readiness-service.js';
import {
  needsDisabledTestsDecision,
  WorktreePreparationService,
  WorktreeReadinessBlockedError,
} from '../src/worktree-preparation-service.js';
import { mkRepoLocalTempDir } from './helpers/temp-repo.js';

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function createRepo(prefix: string): string {
  const repoRoot = mkRepoLocalTempDir(prefix);
  git(repoRoot, ['init', '-b', 'main']);
  writeFileSync(path.join(repoRoot, 'README.md'), 'test\n');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'test']);
  return repoRoot;
}

test('derives names and honors overrides', () => {
  const checkout = {
    featureSlug: 'feature-a',
    defaultWorktreeName: 'feature-a',
    effectiveWorktreeName: 'custom-tree',
    defaultBranchName: 'feature-a',
    effectiveBranchName: 'local/branch',
    worktreePath: '/repo/custom-tree',
  };
  assert.equal(checkout.defaultWorktreeName, 'feature-a');
  assert.equal(checkout.effectiveWorktreeName, 'custom-tree');
  assert.equal(checkout.defaultBranchName, 'feature-a');
  assert.equal(checkout.effectiveBranchName, 'local/branch');
  assert.match(
    buildPrompt({
      checkout,
      ticket: {
        path: '/tmp/ticket.md',
        feature: 'feature-a',
        issueName: '001',
        label: 'feature-a/001',
        executorAfk: true,
      },
      ticketContent: 'Status: ready-for-agent',
    }),
    /Use this prepared checkout/,
  );
});

test('fails clearly when the target worktree path exists but is not registered', () => {
  const repoRoot = createRepo('afk-worktree-stale-');
  mkdirSync(path.join(repoRoot, '.worktree', 'feature-stale'), { recursive: true });

  assert.throws(
    () => new WorktreePreparationService().prepare({ repoRoot, featureSlug: 'feature-stale' }),
    /already exists but is not registered with git/,
  );
});

test('creates or reuses a persistent local worktree and branch', () => {
  const repoRoot = createRepo('afk-worktree-reuse-');

  const service = new WorktreePreparationService();
  const first = service.prepare({ repoRoot, featureSlug: 'feat-one' });
  const second = service.prepare({ repoRoot, featureSlug: 'feat-one' });

  assert.equal(first.effectiveWorktreeName, 'feat-one');
  assert.equal(second.effectiveWorktreeName, 'feat-one');
  assert.match(git(repoRoot, ['branch', '--list', 'feat-one']), /feat-one/);
  assert.equal(
    git(repoRoot, ['worktree', 'list', '--porcelain']).includes(`worktree ${realpathSync(first.worktreePath)}`),
    true,
  );
});

test('fails clearly when git rejects the requested branch state', () => {
  const repoRoot = createRepo('afk-worktree-fail-');
  git(repoRoot, ['branch', 'conflict']);

  const service = new WorktreePreparationService();
  assert.throws(() =>
    service.prepare({ repoRoot, featureSlug: 'conflict', ticketOverrides: { afk_branch: 'invalid branch name' } }),
  );
});

test('prepares worktrees under ignored repo-local .worktree directory', () => {
  const repoRoot = createRepo('afk-worktree-');
  const result = new WorktreePreparationService().prepare({ repoRoot, featureSlug: 'feature-a' });

  assert.equal(result.worktreePath, path.join(repoRoot, '.worktree', 'feature-a'));
  assert.equal(result.effectiveBranchName, 'feature-a');
  assert.equal(existsSync(path.join(repoRoot, '.worktree')), true);
  assert.equal(existsSync(result.worktreePath), true);
  assert.match(readFileSync(path.join(repoRoot, '.gitignore'), 'utf8'), /^\.worktree\/$/m);
});

test('preserves existing gitignore contents when adding worktree ignore', () => {
  const repoRoot = createRepo('afk-worktree-ignore-');
  writeFileSync(path.join(repoRoot, '.gitignore'), '.scratch\n');

  new WorktreePreparationService().prepare({ repoRoot, featureSlug: 'feature-b' });

  assert.equal(readFileSync(path.join(repoRoot, '.gitignore'), 'utf8'), '.scratch\n.worktree/\n');
});

test('copies allowlisted dependencies and .env.testing for new worktrees', () => {
  const repoRoot = createRepo('afk-worktree-copy-');
  mkdirSync(path.join(repoRoot, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  mkdirSync(path.join(repoRoot, 'vendor', 'bin'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'vendor', 'bin', 'tool'), 'ok\n');
  writeFileSync(path.join(repoRoot, '.env.testing'), 'TEST_VALUE=yes\n');
  writeFileSync(path.join(repoRoot, '.env'), 'SECRET=never-copy\n');

  const result = new WorktreePreparationService().prepare({ repoRoot, featureSlug: 'copy-ready' });

  assert.equal(existsSync(path.join(result.worktreePath, 'node_modules', 'pkg', 'index.js')), true);
  assert.equal(existsSync(path.join(result.worktreePath, 'vendor', 'bin', 'tool')), true);
  assert.equal(readFileSync(path.join(result.worktreePath, '.env.testing'), 'utf8'), 'TEST_VALUE=yes\n');
  assert.equal(existsSync(path.join(result.worktreePath, '.env')), false);
  assert.deepEqual(
    result.readiness?.dependencyCopies.filter((item) => item.name === 'node_modules').map((item) => item.decision),
    ['copied'],
  );
  assert.equal(result.readiness?.envTestingCopy.decision, 'copied');
});

test('does not overwrite existing target dependencies or env files', () => {
  const repoRoot = createRepo('afk-worktree-no-overwrite-');
  mkdirSync(path.join(repoRoot, 'venv', 'lib'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'venv', 'lib', 'from-source.txt'), 'source\n');
  writeFileSync(path.join(repoRoot, '.env.testing'), 'SOURCE=yes\n');

  const service = new WorktreePreparationService();
  const first = service.prepare({ repoRoot, featureSlug: 'copy-existing' });
  writeFileSync(path.join(first.worktreePath, 'venv', 'lib', 'from-target.txt'), 'target\n');
  writeFileSync(path.join(first.worktreePath, '.env.testing'), 'TARGET=yes\n');

  const second = service.prepare({ repoRoot, featureSlug: 'copy-existing' });
  assert.equal(existsSync(path.join(second.worktreePath, 'venv', 'lib', 'from-source.txt')), true);
  assert.equal(readFileSync(path.join(second.worktreePath, '.env.testing'), 'utf8'), 'TARGET=yes\n');
  assert.equal(second.readiness?.dependencyCopies.find((item) => item.name === 'venv')?.decision, 'already-present');
  assert.equal(second.readiness?.envTestingCopy.decision, 'already-present');
});

test('blocks copying symlinked dependency directories that point outside source checkout', () => {
  const repoRoot = createRepo('afk-worktree-symlink-');
  const outsideRoot = mkRepoLocalTempDir('afk-worktree-outside-');
  mkdirSync(path.join(outsideRoot, 'dep'), { recursive: true });
  writeFileSync(path.join(outsideRoot, 'dep', 'leak.txt'), 'outside\n');
  symlinkSync(path.join(outsideRoot, 'dep'), path.join(repoRoot, 'node_modules'), 'dir');

  const result = new WorktreePreparationService().prepare({ repoRoot, featureSlug: 'symlink-guard' });

  assert.equal(existsSync(path.join(result.worktreePath, 'node_modules')), false);
  assert.equal(
    result.readiness?.dependencyCopies.find((item) => item.name === 'node_modules')?.decision,
    'blocked-external-symlink',
  );
  assert.match(
    result.readiness?.dependencyCopies.find((item) => item.name === 'node_modules')?.note ?? '',
    /outside source checkout/,
  );

  rmSync(outsideRoot, { recursive: true, force: true });
});

test('detects configured test suites and blocks missing env without disabled confirmation', () => {
  const repoRoot = createRepo('afk-worktree-missing-env-');
  writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ scripts: { test: 'bun test tests/*.test.ts' } }));
  mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'tests', 'sample.test.ts'), 'test("x", () => {});\n');

  assert.equal(detectTestSuite(repoRoot).detected, true);
  assert.equal(needsDisabledTestsDecision(repoRoot), true);
  assert.throws(
    () => new WorktreePreparationService().prepare({ repoRoot, featureSlug: 'missing-env' }),
    WorktreeReadinessBlockedError,
  );
});

test('records disabled tests decision when missing env is confirmed', () => {
  const repoRoot = createRepo('afk-worktree-disabled-tests-');
  writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ scripts: { test: 'bun test tests/*.test.ts' } }));
  mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'tests', 'sample.test.ts'), 'test("x", () => {});\n');

  const result = new WorktreePreparationService().prepare({
    repoRoot,
    featureSlug: 'disabled-tests',
    testsDisabledByUser: true,
  });

  assert.equal(result.readiness?.checks?.terminalState, 'disabled-by-user');
  assert.equal(result.readiness?.checks?.testSuite.envTesting, 'missing-disabled-by-user');
  assert.equal(result.readiness?.checks?.smoke.status, 'skipped');
});

test('readiness checks preconditions and deterministic smoke/static commands', () => {
  const repoRoot = createRepo('afk-readiness-checks-');
  writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ scripts: { test: 'bun test tests/*.test.ts', lint: 'eslint .' } }),
  );
  mkdirSync(path.join(repoRoot, 'tests', 'nested'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'tests', 'b.test.ts'), 'b\n');
  writeFileSync(path.join(repoRoot, 'tests', 'nested', 'a.test.ts'), 'a\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'tests']);
  const worktreePath = path.join(repoRoot, '.worktree', 'ready');
  git(repoRoot, ['branch', 'ready']);
  git(repoRoot, ['worktree', 'add', worktreePath, 'ready']);
  const commands: string[] = [];
  const executor: ReadinessCommandExecutor = {
    run: (command) => {
      commands.push(command);
      return { exitCode: 0, output: 'ok' };
    },
  };

  const readiness = buildWorktreeReadiness({
    repoRoot,
    worktreePath,
    expectedBranch: 'ready',
    selectedTicketPaths: [path.join(repoRoot, 'README.md')],
    envTestingDecision: 'present',
    dependencyCopyStatusKnown: true,
    executor,
  });

  assert.equal(readiness.terminalState, 'passed');
  assert.match(readiness.smoke.command, /tests\/b\.test\.ts/);
  assert.deepEqual(commands, [readiness.smoke.command, 'npm run lint --silent']);
});

test('readiness uses afk.json commands instead of inferred package scripts', () => {
  const repoRoot = createRepo('afk-readiness-config-');
  writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ scripts: { test: 'bun test tests/*.test.ts', lint: 'eslint .' } }),
  );
  mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'tests', 'a.test.ts'), 'a\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'tests']);
  const worktreePath = path.join(repoRoot, '.worktree', 'config-ready');
  git(repoRoot, ['branch', 'config-ready']);
  git(repoRoot, ['worktree', 'add', worktreePath, 'config-ready']);
  const commands: string[] = [];
  const executor: ReadinessCommandExecutor = {
    run: (command) => {
      commands.push(command);
      return { exitCode: 0, output: 'ok' };
    },
  };

  const readiness = buildWorktreeReadiness({
    repoRoot,
    worktreePath,
    expectedBranch: 'config-ready',
    envTestingDecision: 'not-required',
    dependencyCopyStatusKnown: true,
    config: { testsEnabled: true, smokeTestCommand: 'bun test {testFile}', staticCheckCommands: ['bun run build'] },
    executor,
  });

  assert.equal(readiness.terminalState, 'passed');
  assert.deepEqual(commands, ["bun test 'tests/a.test.ts'", 'bun run build']);
  assert.deepEqual(readiness.testSuite.signals, ['afk-config']);
});

test('readiness uses Pest when PHP tests are Pest-based', () => {
  const repoRoot = createRepo('afk-readiness-pest-');
  writeFileSync(path.join(repoRoot, 'composer.json'), JSON.stringify({ 'require-dev': { 'pestphp/pest': '^4.1' } }));
  writeFileSync(path.join(repoRoot, 'phpunit.xml'), '<phpunit/>\n');
  mkdirSync(path.join(repoRoot, 'tests', 'Feature'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'tests', 'Pest.php'), '<?php\n');
  writeFileSync(path.join(repoRoot, 'tests', 'Feature', 'AccountsPageTest.php'), '<?php\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'tests']);
  const worktreePath = path.join(repoRoot, '.worktree', 'pest');
  git(repoRoot, ['branch', 'pest']);
  git(repoRoot, ['worktree', 'add', worktreePath, 'pest']);
  const commands: string[] = [];
  const executor: ReadinessCommandExecutor = {
    run: (command) => {
      commands.push(command);
      return { exitCode: 0, output: 'ok' };
    },
  };

  const readiness = buildWorktreeReadiness({
    repoRoot,
    worktreePath,
    expectedBranch: 'pest',
    envTestingDecision: 'present',
    dependencyCopyStatusKnown: true,
    executor,
  });

  assert.equal(readiness.terminalState, 'passed');
  assert.match(readiness.smoke.command, /^vendor\/bin\/pest '/);
  assert.match(readiness.smoke.command, /tests\/Feature\/AccountsPageTest\.php/);
  assert.deepEqual(commands, [readiness.smoke.command]);
});

test('readiness blocks failed smoke command with bounded output', () => {
  const repoRoot = createRepo('afk-readiness-fail-');
  writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ scripts: { test: 'bun test tests/*.test.ts' } }));
  mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'tests', 'a.test.ts'), 'a\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'tests']);
  const worktreePath = path.join(repoRoot, '.worktree', 'fail');
  git(repoRoot, ['branch', 'fail']);
  git(repoRoot, ['worktree', 'add', worktreePath, 'fail']);
  const executor: ReadinessCommandExecutor = { run: () => ({ exitCode: 2, output: 'x'.repeat(1200) }) };

  const readiness = buildWorktreeReadiness({
    repoRoot,
    worktreePath,
    expectedBranch: 'fail',
    envTestingDecision: 'present',
    dependencyCopyStatusKnown: true,
    executor,
  });

  assert.equal(readiness.terminalState, 'blocked');
  assert.equal(readiness.smoke.status, 'failed');
  assert.equal(readiness.smoke.outputSnippet?.length, 1000);
});

test('readiness detects stale git index lock in linked worktree git dir', () => {
  const repoRoot = createRepo('afk-readiness-lock-');
  const worktreePath = path.join(repoRoot, '.worktree', 'lock');
  git(repoRoot, ['branch', 'lock']);
  git(repoRoot, ['worktree', 'add', worktreePath, 'lock']);
  const lockPath = git(worktreePath, ['rev-parse', '--git-path', 'index.lock']);
  writeFileSync(lockPath, 'stale\n');

  const readiness = buildWorktreeReadiness({
    repoRoot,
    worktreePath,
    expectedBranch: 'lock',
    envTestingDecision: 'not-required',
    dependencyCopyStatusKnown: true,
  });

  assert.equal(readiness.terminalState, 'blocked');
  assert.match(readiness.blockReason ?? '', /index lock/);
});
