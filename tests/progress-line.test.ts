import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProgressLine } from '../src/progress-line.js';

test('progress line is a no-op for non-tty output', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(false, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.update({ ticketLabel: 'feat/001', message: 'starting' });
  progressLine.done();

  assert.deepEqual(writes, []);
});

test('progress line updates in place and finalizes once', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.update({ ticketLabel: 'feat/001', message: 'starting' });
  progressLine.update({ ticketLabel: 'feat/001', message: 'opencode session completed', sessionId: 'abc' });
  progressLine.done();

  const output = writes.join('');
  assert.match(output, /[|\/\\-]: starting/);
  assert.match(output, /[|\/\\-]: opencode session completed \[opencode: abc\]/);
  assert.doesNotMatch(output, /feat\/001/);
  assert.doesNotMatch(output, /AFK running/);
  assert.match(output, /\u001B\[2K|\r/);
  assert.equal(output.endsWith('\n'), true);
});

test('progress line does not repeat an id already present in the message', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.update({ ticketLabel: 'feat/001', message: 'created opencode session abc', sessionId: 'abc' });
  progressLine.done();

  const output = writes.join('');
  assert.match(output, /created opencode session abc/);
  assert.doesNotMatch(output, /\[opencode: abc\]/);
});

test('progress line prints durable permission requests', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.update({ ticketLabel: 'feat/001', message: 'opencode session busy', sessionId: 'session-1' });
  progressLine.update({ ticketLabel: 'feat/001', kind: 'permission', message: 'opencode permission required: external_directory for /tmp/worktree/*; requested ask', sessionId: 'session-1', permissionId: 'per_1' });
  progressLine.update({ ticketLabel: 'feat/001', message: 'opencode session busy', sessionId: 'session-1' });
  progressLine.done();

  const output = writes.join('');
  assert.match(output, /Permission required for feat\/001/);
  assert.match(output, /external_directory/);
  assert.match(output, /\[opencode: session-1\]/);
  assert.equal((output.match(/Permission required for feat\/001/g) ?? []).length, 1);
});

test('progress line resumes after permission is resolved', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.update({ ticketLabel: 'feat/001', kind: 'permission', message: 'opencode permission required: bash; requested allow', permissionId: 'per_1' });
  progressLine.update({ ticketLabel: 'feat/001', message: 'tool bash running: bun test' });
  progressLine.done();

  const output = writes.join('');
  assert.match(output, /Permission required for feat\/001/);
  assert.match(output, /tool bash running: bun test/);
});

test('progress line suppresses normal writes while prompt is active', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  let promptActive = true;
  const progressLine = createProgressLine(stdout, { isPromptActive: () => promptActive });

  progressLine.update({ ticketLabel: 'feat/001', message: 'tool bash running: bun test' });
  progressLine.update({ ticketLabel: 'feat/001', message: 'opencode session busy' });
  assert.equal(writes.length, 0);

  promptActive = false;
  progressLine.update({ ticketLabel: 'feat/001', message: 'tool bash completed: bun test' });
  progressLine.done();

  const output = writes.join('');
  assert.match(output, /tool bash completed: bun test/);
  assert.doesNotMatch(output, /tool bash running: bun test/);
});

test('progress line pauses spinner redraw while prompt is active', async () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  let promptActive = false;
  const progressLine = createProgressLine(stdout, { isPromptActive: () => promptActive });

  progressLine.update({ ticketLabel: 'feat/001', message: 'starting' });
  const writesBeforePrompt = writes.length;
  await wait(160);
  const writesAfterFirstTick = writes.length;
  assert.ok(writesAfterFirstTick > writesBeforePrompt);

  promptActive = true;
  await wait(160);
  const writesDuringPrompt = writes.length;
  await wait(160);
  assert.equal(writes.length, writesDuringPrompt);

  promptActive = false;
  progressLine.update({ ticketLabel: 'feat/001', message: 'resumed' });
  await wait(160);
  assert.ok(writes.length > writesDuringPrompt);

  progressLine.done();
});

test('progress line prints durable provider failures', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.update({ ticketLabel: 'feat/001', message: 'opencode session busy', sessionId: 'session-1' });
  progressLine.update({ ticketLabel: 'feat/001', kind: 'failure', message: 'provider failure: selected implementation model github-copilot/claude-sonnet-4.6 is unavailable', sessionId: 'session-1' });
  progressLine.done();

  const output = writes.join('');
  assert.match(output, /Provider failure for feat\/001/);
  assert.match(output, /claude-sonnet-4\.6 is unavailable/);
  assert.match(output, /\[opencode: session-1\]/);
});

function fakeStdout(isTTY: boolean, writes: string[]): NodeJS.WriteStream {
  return {
    isTTY,
    columns: 80,
    rows: 24,
    write: (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    },
  } as NodeJS.WriteStream;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
