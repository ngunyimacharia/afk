import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLiveRunView } from '../src/live-run-view.js';
import { createProgressLine } from '../src/progress-line.js';

test('progress line is a no-op for non-tty output', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(false, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.update({ ticketLabel: 'feat/001', message: 'starting' });
  progressLine.done();

  assert.deepEqual(writes, []);
});

test('progress line cleanup is safe to call multiple times', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.update({ ticketLabel: 'feat/001', message: 'starting' });
  progressLine.cleanup();
  progressLine.cleanup();
  progressLine.done();

  // Cleanup finalizes output; subsequent cleanup/done should not throw or re-emit.
  assert.doesNotThrow(() => progressLine.done());
  assert.doesNotThrow(() => progressLine.cleanup());
});

test('progress line done is safe to call multiple times', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.update({ ticketLabel: 'feat/001', message: 'starting' });
  progressLine.done();
  const outputAfterFirstDone = writes.join('');

  progressLine.done();
  const outputAfterSecondDone = writes.join('');

  assert.equal(outputAfterFirstDone, outputAfterSecondDone);
});

test('live run view factory creates text progress line for tty', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const view = createLiveRunView({ kind: 'text', stdout });

  view.update({ ticketLabel: 'feat/001', message: 'starting' });
  view.done();

  const output = writes.join('');
  assert.match(output, /[|/\\-]: starting/);
});

test('live run view factory falls back to no-op for non-tty', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(false, writes);
  const view = createLiveRunView({ kind: 'text', stdout });

  view.update({ ticketLabel: 'feat/001', message: 'starting' });
  view.done();

  assert.deepEqual(writes, []);
});

test('live run view factory falls back to no-op for non-tty dashboard kind', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(false, writes);
  const view = createLiveRunView({ kind: 'dashboard', stdout });

  view.update({ ticketLabel: 'feat/001', message: 'starting' });
  view.done();

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
  assert.match(output, /[|/\\-]: starting/);
  assert.match(output, /[|/\\-]: opencode session completed \[opencode: abc\]/);
  assert.doesNotMatch(output, /feat\/001/);
  assert.doesNotMatch(output, /AFK running/);
  assert.equal(output.includes('\x1B[2K') || output.includes('\r'), true);
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
  progressLine.update({
    ticketLabel: 'feat/001',
    kind: 'permission',
    message: 'opencode permission required: external_directory for /tmp/worktree/*; requested ask',
    sessionId: 'session-1',
    permissionId: 'per_1',
  });
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

  progressLine.update({
    ticketLabel: 'feat/001',
    kind: 'permission',
    message: 'opencode permission required: bash; requested allow',
    permissionId: 'per_1',
  });
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
  progressLine.update({
    ticketLabel: 'feat/001',
    kind: 'failure',
    message: 'provider failure: selected implementation model github-copilot/claude-sonnet-4.6 is unavailable',
    sessionId: 'session-1',
  });
  progressLine.done();

  const output = writes.join('');
  assert.match(output, /Provider failure for feat\/001/);
  assert.match(output, /claude-sonnet-4\.6 is unavailable/);
  assert.match(output, /\[opencode: session-1\]/);
});

test('progress line renders notification state when permission is the first event', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.update({
    ticketLabel: 'feat/001',
    kind: 'permission',
    message: 'opencode permission required: bash; requested allow',
    permissionId: 'per_1',
  });
  progressLine.updateNotificationState({
    capability: 'supported',
    lastDelivery: {
      state: 'sent',
      payload: {
        title: 'Permission required: feat/001',
        message: 'bash tool requested',
        category: 'permission-required',
      },
    },
  });
  progressLine.done();

  const output = writes.join('');
  assert.match(output, /Permission required for feat\/001/);
  assert.match(output, /\[notified: Permission required: feat\/001\]/);
  assert.equal(output.endsWith('\n'), true);
});

test('progress line renders notification state when failure is the first event', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.update({
    ticketLabel: 'feat/001',
    kind: 'failure',
    message: 'provider failure: model unavailable',
  });
  progressLine.updateNotificationState({
    capability: 'supported',
    lastDelivery: {
      state: 'sent',
      payload: {
        title: 'Failed: feat/001',
        message: 'The ticket failed during execution.',
        category: 'ticket-failed',
      },
    },
  });
  progressLine.done();

  const output = writes.join('');
  assert.match(output, /Provider failure for feat\/001/);
  assert.match(output, /\[notified: Failed: feat\/001\]/);
  assert.equal(output.endsWith('\n'), true);
});

test('progress line finalizes after notification re-render following permission event', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.update({ ticketLabel: 'feat/001', message: 'starting' });
  progressLine.update({
    ticketLabel: 'feat/001',
    kind: 'permission',
    message: 'opencode permission required: bash; requested allow',
    permissionId: 'per_1',
  });
  progressLine.updateNotificationState({
    capability: 'supported',
    lastDelivery: {
      state: 'sent',
      payload: {
        title: 'Permission required: feat/001',
        message: 'bash tool requested',
        category: 'permission-required',
      },
    },
  });
  progressLine.done();

  const output = writes.join('');
  assert.match(output, /Permission required for feat\/001/);
  assert.match(output, /\[notified: Permission required: feat\/001\]/);
  assert.equal(output.endsWith('\n'), true);
});

test('progress line finalizes after notification re-render following failure event', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.update({ ticketLabel: 'feat/001', message: 'starting' });
  progressLine.update({
    ticketLabel: 'feat/001',
    kind: 'failure',
    message: 'provider failure: model unavailable',
  });
  progressLine.updateNotificationState({
    capability: 'supported',
    lastDelivery: {
      state: 'sent',
      payload: {
        title: 'Failed: feat/001',
        message: 'The ticket failed during execution.',
        category: 'ticket-failed',
      },
    },
  });
  progressLine.done();

  const output = writes.join('');
  assert.match(output, /Provider failure for feat\/001/);
  assert.match(output, /\[notified: Failed: feat\/001\]/);
  assert.equal(output.endsWith('\n'), true);
});

test('progress line uses providerName for kimi harness', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const progressLine = createProgressLine(stdout, { providerName: 'kimi' });

  progressLine.update({ ticketLabel: 'feat/001', message: 'kimi session completed', sessionId: 'abc' });
  progressLine.done();

  const output = writes.join('');
  assert.match(output, /\[kimi: abc\]/);
  assert.doesNotMatch(output, /\[opencode:/);
});

test('progress line renders unsupported notification capability', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.updateNotificationState({ capability: 'unsupported' });
  progressLine.update({ ticketLabel: 'feat/001', message: 'starting' });
  progressLine.done();

  const output = writes.join('');
  assert.match(output, /\[notifications unavailable\]/);
});

test('progress line renders sent notification state with payload', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.updateNotificationState({
    capability: 'supported',
    lastDelivery: {
      state: 'sent',
      payload: {
        title: 'Permission required: feat/001',
        message: 'bash tool requested',
        category: 'permission-required',
      },
    },
  });
  progressLine.update({ ticketLabel: 'feat/001', message: 'starting' });
  progressLine.done();

  const output = writes.join('');
  assert.match(output, /\[notified: Permission required: feat\/001\]/);
});

test('progress line renders failed notification state with payload', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.updateNotificationState({
    capability: 'supported',
    lastDelivery: {
      state: 'failed',
      payload: {
        title: 'Run completed',
        message: '2 ticket(s) completed successfully.',
        category: 'run-completed-success',
      },
    },
  });
  progressLine.update({ ticketLabel: 'feat/001', message: 'starting' });
  progressLine.done();

  const output = writes.join('');
  assert.match(output, /\[notification failed: Run completed\]/);
});

test('progress line hides skipped notification state', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.updateNotificationState({
    capability: 'supported',
    lastDelivery: {
      state: 'skipped',
    },
  });
  progressLine.update({ ticketLabel: 'feat/001', message: 'starting' });
  progressLine.done();

  const output = writes.join('');
  assert.doesNotMatch(output, /notified/);
  assert.doesNotMatch(output, /notification/);
});

test('progress line does not render notification state for non-tty output', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(false, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.updateNotificationState({ capability: 'unsupported' });
  progressLine.update({ ticketLabel: 'feat/001', message: 'starting' });
  progressLine.done();

  assert.deepEqual(writes, []);
});

test('progress line re-renders when notification state changes after initial render', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.update({ ticketLabel: 'feat/001', message: 'starting' });
  const writesBefore = writes.length;
  progressLine.updateNotificationState({ capability: 'unsupported' });
  const writesAfter = writes.length;

  assert.ok(writesAfter > writesBefore);
});

test('progress line re-renders notification state after permission event', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.update({ ticketLabel: 'feat/001', message: 'starting' });
  progressLine.update({
    ticketLabel: 'feat/001',
    kind: 'permission',
    message: 'opencode permission required: bash; requested allow',
    permissionId: 'per_1',
  });
  const writesBeforeNotification = writes.length;
  progressLine.updateNotificationState({
    capability: 'supported',
    lastDelivery: {
      state: 'sent',
      payload: {
        title: 'Permission required: feat/001',
        message: 'bash tool requested',
        category: 'permission-required',
      },
    },
  });
  const writesAfterNotification = writes.length;

  assert.ok(writesAfterNotification > writesBeforeNotification);
  const lastWrite = writes[writes.length - 1];
  assert.match(lastWrite, /\[notified: Permission required: feat\/001\]/);
});

test('progress line re-renders notification state after failure event', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.update({ ticketLabel: 'feat/001', message: 'starting' });
  progressLine.update({
    ticketLabel: 'feat/001',
    kind: 'failure',
    message: 'provider failure: model unavailable',
  });
  const writesBeforeNotification = writes.length;
  progressLine.updateNotificationState({
    capability: 'supported',
    lastDelivery: {
      state: 'sent',
      payload: {
        title: 'Failed: feat/001',
        message: 'The ticket failed during execution.',
        category: 'ticket-failed',
      },
    },
  });
  const writesAfterNotification = writes.length;

  assert.ok(writesAfterNotification > writesBeforeNotification);
  const lastWrite = writes[writes.length - 1];
  assert.match(lastWrite, /\[notified: Failed: feat\/001\]/);
});

test('progress line ignores notification state update after done', () => {
  const writes: string[] = [];
  const stdout = fakeStdout(true, writes);
  const progressLine = createProgressLine(stdout);

  progressLine.update({ ticketLabel: 'feat/001', message: 'starting' });
  progressLine.done();
  const writesAfterDone = writes.length;
  progressLine.updateNotificationState({
    capability: 'supported',
    lastDelivery: {
      state: 'sent',
      payload: {
        title: 'Run completed',
        message: 'All tickets done',
        category: 'run-completed-success',
      },
    },
  });

  assert.equal(writes.length, writesAfterDone);
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
