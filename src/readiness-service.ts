import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveExecutable } from './executable-resolution.js';
import type { AfkProjectConfig } from './project-config.js';

export type ReadinessTerminalState = 'passed' | 'disabled-by-user' | 'blocked';

export interface ReadinessCommandResult {
  command: string;
  mode: 'smoke' | 'static-style';
  status: 'passed' | 'failed' | 'skipped';
  exitCode?: number;
  outputSnippet?: string;
  reason?: string;
}

export interface EnvironmentReadinessResult {
  status: 'passed' | 'failed' | 'skipped';
  command?: string;
  exitCode?: number;
  output?: string;
  reason?: string;
}

export interface ReadinessCheckMetadata {
  worktreePath: { status: 'passed' | 'blocked'; path: string; reason?: string };
  branch: { status: 'passed' | 'blocked'; expected: string; actual?: string; reason?: string };
  ticketPaths: { status: 'passed' | 'blocked'; missing: string[] };
  gitIndexLock: { status: 'passed' | 'blocked'; path: string };
  dependencyCopyStatusKnown: { status: 'passed' | 'blocked' };
  testSuite: {
    detected: boolean;
    signals: string[];
    envTesting: 'present' | 'missing-disabled-by-user' | 'missing-blocking' | 'not-required';
  };
  environmentReadiness?: EnvironmentReadinessResult;
  smoke: ReadinessCommandResult;
  staticStyleChecks: ReadinessCommandResult[];
  terminalState: ReadinessTerminalState;
  blockReason?: string;
}

export interface ReadinessCommandExecutor {
  run(command: string, cwd: string): { exitCode: number; output: string };
}

export class SyncReadinessCommandExecutor implements ReadinessCommandExecutor {
  run(command: string, cwd: string): { exitCode: number; output: string } {
    const options: ExecFileSyncOptionsWithStringEncoding = {
      cwd,
      encoding: 'utf8',
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    try {
      return { exitCode: 0, output: execFileSync(command, options) };
    } catch (error) {
      const err = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
      return {
        exitCode: typeof err.status === 'number' ? err.status : 1,
        output: `${err.stdout ?? ''}${err.stderr ?? ''}` || err.message || 'command failed',
      };
    }
  }
}

export function detectTestSuite(repoRoot: string): { detected: boolean; signals: string[] } {
  const signals: string[] = [];
  if (existsSync(path.join(repoRoot, 'artisan'))) signals.push('laravel-artisan');
  if (existsSync(path.join(repoRoot, 'phpunit.xml')) || existsSync(path.join(repoRoot, 'phpunit.xml.dist')))
    signals.push('phpunit-config');
  const composer = readJson(path.join(repoRoot, 'composer.json'));
  if (composer && (composer.require || composer['require-dev'] || composer.scripts)) signals.push('composer');
  const packageJson = readJson(path.join(repoRoot, 'package.json'));
  if (
    packageJson?.scripts &&
    Object.keys(packageJson.scripts as Record<string, unknown>).some((name) => /(^|:)(test|spec)s?($|:)/i.test(name))
  )
    signals.push('package-test-script');
  if (hasTestFiles(path.join(repoRoot, 'tests'))) signals.push('tests-directory');
  return { detected: signals.length > 0, signals };
}

export function runReadinessCommands(input: {
  cwd: string;
  config?: AfkProjectConfig;
  executor?: ReadinessCommandExecutor;
}): { smoke: ReadinessCommandResult; staticStyleChecks: ReadinessCommandResult[] } {
  const executor = input.executor ?? new SyncReadinessCommandExecutor();
  const smoke = runSmokeCheck(input.cwd, executor, input.config);
  const staticStyleChecks = runStaticStyleChecks(input.cwd, executor, input.config);
  return { smoke, staticStyleChecks };
}

export function buildWorktreeReadiness(input: {
  repoRoot: string;
  worktreePath: string;
  expectedBranch: string;
  selectedTicketPaths?: string[];
  envTestingDecision: 'present' | 'missing-disabled-by-user' | 'missing-blocking' | 'not-required';
  dependencyCopyStatusKnown: boolean;
  config?: AfkProjectConfig;
  executor?: ReadinessCommandExecutor;
  skipCommandChecks?: boolean;
  environmentReadiness?: EnvironmentReadinessResult;
}): ReadinessCheckMetadata {
  const executor = input.executor ?? new SyncReadinessCommandExecutor();
  const testSuite = input.config
    ? { detected: input.config.testsEnabled, signals: input.config.testsEnabled ? ['afk-config'] : [] }
    : detectTestSuite(input.repoRoot);
  const preconditions = evaluatePreconditions(input);
  const environmentReadiness = input.environmentReadiness;
  const blockReason =
    environmentReadiness?.status === 'failed'
      ? (environmentReadiness.reason ?? 'environment readiness failed')
      : firstBlockReason(preconditions);
  if (blockReason)
    return finalize({
      ...preconditions,
      testSuite: { ...testSuite, envTesting: input.envTestingDecision },
      environmentReadiness,
      smoke: skipped('smoke', blockReason),
      staticStyleChecks: [],
      blockReason,
    });
  if (input.envTestingDecision === 'missing-blocking') {
    const reason = 'Detected tests but source .env.testing is missing and disabled tests were not confirmed.';
    return finalize({
      ...preconditions,
      testSuite: { ...testSuite, envTesting: input.envTestingDecision },
      environmentReadiness,
      smoke: skipped('smoke', reason),
      staticStyleChecks: [],
      blockReason: reason,
    });
  }
  if (input.skipCommandChecks) {
    return finalize({
      ...preconditions,
      testSuite: { ...testSuite, envTesting: input.envTestingDecision },
      environmentReadiness,
      smoke: skipped('smoke', 'existing worktree'),
      staticStyleChecks: [],
    });
  }
  if (input.envTestingDecision === 'missing-disabled-by-user') {
    return finalize({
      ...preconditions,
      testSuite: { ...testSuite, envTesting: input.envTestingDecision },
      environmentReadiness,
      smoke: skipped('smoke', 'tests disabled by user'),
      staticStyleChecks: runStaticStyleChecks(input.worktreePath, executor, input.config),
    });
  }

  const smoke = runSmokeCheck(input.worktreePath, executor, input.config);
  const staticStyleChecks = runStaticStyleChecks(input.worktreePath, executor, input.config);
  const failed = [smoke, ...staticStyleChecks].find((item) => item.status === 'failed');
  return finalize({
    ...preconditions,
    testSuite: { ...testSuite, envTesting: input.envTestingDecision },
    environmentReadiness,
    smoke,
    staticStyleChecks,
    blockReason: failed ? `${failed.mode} readiness failed: ${failed.command}` : undefined,
  });
}

function evaluatePreconditions(input: {
  worktreePath: string;
  expectedBranch: string;
  selectedTicketPaths?: string[];
  dependencyCopyStatusKnown: boolean;
}): Pick<
  ReadinessCheckMetadata,
  'worktreePath' | 'branch' | 'ticketPaths' | 'gitIndexLock' | 'dependencyCopyStatusKnown'
> {
  const worktreeExists = existsSync(input.worktreePath);
  const actualBranch = worktreeExists ? readBranch(input.worktreePath) : undefined;
  const missing = (input.selectedTicketPaths ?? []).filter((ticketPath) => !existsSync(ticketPath));
  const gitIndexLockPath = worktreeExists
    ? gitPath(input.worktreePath, 'index.lock')
    : path.join(input.worktreePath, '.git', 'index.lock');
  return {
    worktreePath: worktreeExists
      ? { status: 'passed', path: input.worktreePath }
      : { status: 'blocked', path: input.worktreePath, reason: 'worktree path does not exist' },
    branch:
      actualBranch === input.expectedBranch
        ? { status: 'passed', expected: input.expectedBranch, actual: actualBranch }
        : {
            status: 'blocked',
            expected: input.expectedBranch,
            actual: actualBranch,
            reason: 'expected branch is not checked out',
          },
    ticketPaths: missing.length ? { status: 'blocked', missing } : { status: 'passed', missing: [] },
    gitIndexLock: existsSync(gitIndexLockPath)
      ? { status: 'blocked', path: gitIndexLockPath }
      : { status: 'passed', path: gitIndexLockPath },
    dependencyCopyStatusKnown: input.dependencyCopyStatusKnown ? { status: 'passed' } : { status: 'blocked' },
  };
}

function firstBlockReason(
  input: Pick<
    ReadinessCheckMetadata,
    'worktreePath' | 'branch' | 'ticketPaths' | 'gitIndexLock' | 'dependencyCopyStatusKnown'
  >,
): string | null {
  if (input.worktreePath.status === 'blocked') return input.worktreePath.reason ?? 'worktree path check failed';
  if (input.branch.status === 'blocked') return input.branch.reason ?? 'branch check failed';
  if (input.ticketPaths.status === 'blocked') return `missing selected ticket path: ${input.ticketPaths.missing[0]}`;
  if (input.gitIndexLock.status === 'blocked') return `stale git index lock exists: ${input.gitIndexLock.path}`;
  if (input.dependencyCopyStatusKnown.status === 'blocked') return 'dependency copy status is unknown';
  return null;
}

function runSmokeCheck(
  worktreePath: string,
  executor: ReadinessCommandExecutor,
  config?: AfkProjectConfig,
): ReadinessCommandResult {
  if (config && !config.testsEnabled) return skipped('smoke', 'tests disabled by afk.json');
  const testFile = firstTestFile(path.join(worktreePath, 'tests'));
  if (!testFile) return skipped('smoke', 'no deterministic test file found');
  const command = config
    ? renderSmokeCommand(config.smokeTestCommand ?? '', worktreePath, testFile)
    : smokeCommand(worktreePath, testFile);
  if (!command) return skipped('smoke', 'configured test command does not support a single-file argument');
  return runCommand(command, worktreePath, executor, 'smoke');
}

function runStaticStyleChecks(
  worktreePath: string,
  executor: ReadinessCommandExecutor,
  config?: AfkProjectConfig,
): ReadinessCommandResult[] {
  const commands = config ? config.staticCheckCommands : staticStyleCommands(worktreePath);
  return commands.map((command) => runCommand(command, worktreePath, executor, 'static-style'));
}

function runCommand(
  command: string,
  cwd: string,
  executor: ReadinessCommandExecutor,
  mode: 'smoke' | 'static-style',
): ReadinessCommandResult {
  const result = executor.run(command, cwd);
  return {
    command,
    mode,
    status: result.exitCode === 0 ? 'passed' : 'failed',
    exitCode: result.exitCode,
    outputSnippet: snippet(result.output),
  };
}

function smokeCommand(worktreePath: string, testFile: string): string | null {
  const scripts = packageScripts(worktreePath);
  const testScript = scripts.test;
  const relative = path.relative(worktreePath, testFile);
  if (typeof testScript === 'string' && /\b(bun test|node --test|vitest|jest)\b/.test(testScript))
    return `npm test -- ${shellQuote(relative)}`;
  if (existsSync(path.join(worktreePath, 'phpunit.xml')) || existsSync(path.join(worktreePath, 'phpunit.xml.dist'))) {
    return hasPest(worktreePath)
      ? `vendor/bin/pest ${shellQuote(relative)}`
      : `vendor/bin/phpunit ${shellQuote(relative)}`;
  }
  return null;
}

function renderSmokeCommand(command: string, worktreePath: string, testFile: string): string | null {
  if (!command) return null;
  const relative = path.relative(worktreePath, testFile);
  return command.includes('{testFile}') ? command.replace(/\{testFile\}/g, shellQuote(relative)) : command;
}

function hasPest(worktreePath: string): boolean {
  if (existsSync(path.join(worktreePath, 'tests', 'Pest.php'))) return true;
  const composer = readJson(path.join(worktreePath, 'composer.json'));
  const requireDev = composer?.['require-dev'];
  if (!requireDev || typeof requireDev !== 'object' || Array.isArray(requireDev)) return false;
  return typeof (requireDev as Record<string, unknown>)['pestphp/pest'] === 'string';
}

function staticStyleCommands(worktreePath: string): string[] {
  const scripts = packageScripts(worktreePath);
  const safeNames = ['lint', 'typecheck', 'check', 'format:check'];
  return safeNames
    .filter(
      (name) =>
        typeof scripts[name] === 'string' &&
        (!/\b(write|fix|format)\b/i.test(String(scripts[name])) || name === 'format:check'),
    )
    .map((name) => `npm run ${name} --silent`);
}

function readBranch(worktreePath: string): string | undefined {
  try {
    const gitPath = resolveExecutable('git');
    return execFileSync(gitPath, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

function gitPath(worktreePath: string, name: string): string {
  try {
    const gitPath = resolveExecutable('git');
    return execFileSync(gitPath, ['rev-parse', '--git-path', name], { cwd: worktreePath, encoding: 'utf8' }).trim();
  } catch {
    return path.join(worktreePath, '.git', name);
  }
}

function readJson(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function packageScripts(root: string): Record<string, unknown> {
  const parsed = readJson(path.join(root, 'package.json'));
  return parsed?.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)
    ? (parsed.scripts as Record<string, unknown>)
    : {};
}

function hasTestFiles(dir: string): boolean {
  return Boolean(firstTestFile(dir));
}

function firstTestFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = firstTestFile(entryPath);
      if (nested) return nested;
    } else if (/\.(test|spec)\.[cm]?[jt]sx?$|Test\.php$|\.feature$/.test(entry.name)) return entryPath;
  }
  return null;
}

function skipped(mode: 'smoke' | 'static-style', reason: string): ReadinessCommandResult {
  return { command: '', mode, status: 'skipped', reason };
}

function finalize(input: Omit<ReadinessCheckMetadata, 'terminalState'>): ReadinessCheckMetadata {
  const terminalState: ReadinessTerminalState = input.blockReason
    ? 'blocked'
    : input.testSuite.envTesting === 'missing-disabled-by-user'
      ? 'disabled-by-user'
      : 'passed';
  return { ...input, terminalState };
}

function snippet(output: string): string {
  return output.replace(/\s+$/g, '').slice(0, 1000);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
