import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  logResolvedExecutables,
  RequiredExecutableError,
  resolveExecutable,
  resolveExecutables,
} from '../src/executable-resolution.js';

test('resolveExecutable returns absolute path for existing executable', () => {
  const result = resolveExecutable('git');
  assert.ok(result.length > 0);
  assert.ok(result.startsWith('/'));
});

test('resolveExecutable throws RequiredExecutableError for missing executable', () => {
  assert.throws(
    () => resolveExecutable('afk-nonexistent-executable-12345'),
    (error: unknown) => {
      assert.ok(error instanceof RequiredExecutableError);
      assert.deepEqual((error as RequiredExecutableError).missing, ['afk-nonexistent-executable-12345']);
      assert.match((error as Error).message, /Required executable not found: afk-nonexistent-executable-12345/);
      return true;
    },
  );
});

test('resolveExecutables returns record for all found executables', () => {
  const result = resolveExecutables(['git', 'sh']);
  assert.ok(result.git);
  assert.ok(result.git.startsWith('/'));
  assert.ok(result.sh);
  assert.ok(result.sh.startsWith('/'));
});

test('resolveExecutables throws RequiredExecutableError listing all missing executables', () => {
  assert.throws(
    () => resolveExecutables(['git', 'afk-missing-one-12345', 'afk-missing-two-67890']),
    (error: unknown) => {
      assert.ok(error instanceof RequiredExecutableError);
      assert.deepEqual((error as RequiredExecutableError).missing, ['afk-missing-one-12345', 'afk-missing-two-67890']);
      assert.match(
        (error as Error).message,
        /Required executable not found: afk-missing-one-12345, afk-missing-two-67890/,
      );
      return true;
    },
  );
});

test('resolveExecutables throws for single missing executable', () => {
  assert.throws(
    () => resolveExecutables(['afk-nonexistent-executable-12345']),
    (error: unknown) => {
      assert.ok(error instanceof RequiredExecutableError);
      assert.deepEqual((error as RequiredExecutableError).missing, ['afk-nonexistent-executable-12345']);
      return true;
    },
  );
});

test('logResolvedExecutables writes formatted lines via provided log function', () => {
  const logs: string[] = [];
  logResolvedExecutables({ git: '/usr/bin/git', which: '/usr/bin/which' }, (msg) => logs.push(msg));
  assert.deepEqual(logs, ['Resolved executable: git -> /usr/bin/git', 'Resolved executable: which -> /usr/bin/which']);
});

test('logResolvedExecutables uses console.log by default', () => {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (msg: string) => logs.push(msg);
  try {
    logResolvedExecutables({ git: '/usr/bin/git' });
    assert.deepEqual(logs, ['Resolved executable: git -> /usr/bin/git']);
  } finally {
    console.log = originalLog;
  }
});
