import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnvironmentReadinessChecker } from '../src/environment-readiness-checker.js';
import type { ReadinessCommandExecutor } from '../src/readiness-service.js';

function fakeExecutor(records: Record<string, { exitCode: number; output: string }>): ReadinessCommandExecutor {
  return {
    run: (command) =>
      records[command] ?? {
        exitCode: 127,
        output: 'command not found',
      },
  };
}

test('returns passed when configured command exits zero', () => {
  const checker = new EnvironmentReadinessChecker(
    fakeExecutor({ 'which php': { exitCode: 0, output: '/usr/bin/php\n' } }),
  );

  const result = checker.check('/repo', {
    testsEnabled: false,
    staticCheckCommands: [],
    environmentReadinessCommand: 'which php',
  });

  assert.deepEqual(result, {
    status: 'passed',
    command: 'which php',
    exitCode: 0,
    output: '/usr/bin/php\n',
  });
});

test('returns failed with output when configured command exits non-zero', () => {
  const checker = new EnvironmentReadinessChecker(
    fakeExecutor({ 'php -v': { exitCode: 1, output: 'PHP not available' } }),
  );

  const result = checker.check('/repo', {
    testsEnabled: false,
    staticCheckCommands: [],
    environmentReadinessCommand: 'php -v',
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.command, 'php -v');
  assert.equal(result.exitCode, 1);
  assert.equal(result.output, 'PHP not available');
  assert.match(result.reason ?? '', /environment readiness command failed/);
});

test('returns skipped when no command is configured', () => {
  const checker = new EnvironmentReadinessChecker({ run: () => ({ exitCode: 0, output: '' }) });

  const result = checker.check('/repo', { testsEnabled: false, staticCheckCommands: [] });

  assert.equal(result.status, 'skipped');
  assert.equal(result.command, undefined);
  assert.equal(result.reason, 'no environmentReadinessCommand configured');
});

test('returns skipped when config is undefined', () => {
  const checker = new EnvironmentReadinessChecker({ run: () => ({ exitCode: 0, output: '' }) });

  const result = checker.check('/repo', undefined);

  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'no environmentReadinessCommand configured');
});

test('trims whitespace from configured command', () => {
  let receivedCommand = '';
  const checker = new EnvironmentReadinessChecker({
    run: (command) => {
      receivedCommand = command;
      return { exitCode: 0, output: 'ok' };
    },
  });

  checker.check('/repo', {
    testsEnabled: false,
    staticCheckCommands: [],
    environmentReadinessCommand: '  echo ok  ',
  });

  assert.equal(receivedCommand, 'echo ok');
});
