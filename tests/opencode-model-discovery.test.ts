import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractModelsFromProvidersPayload, extractSessionOutputLines, formatOpenCodeEvent, parseOpenCodeEvent } from '../src/opencode.js';

test('extracts models when provider models are object maps', () => {
  const models = extractModelsFromProvidersPayload({
    providers: [
      {
        id: 'opencode',
        models: {
          'big-pickle': { id: 'big-pickle', name: 'Big Pickle' },
          'deepseek-v4-flash-free': { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free' },
        },
      },
      {
        id: 'opencode-go',
        models: {
          'glm-5': { id: 'glm-5', name: 'GLM 5' },
        },
      },
    ],
  });

  assert.deepEqual(models.map((model) => model.id), [
    'opencode/big-pickle',
    'opencode/deepseek-v4-flash-free',
    'opencode-go/glm-5',
  ]);
});

test('extracts durable session output from assistant message errors and text parts', () => {
  const output = extractSessionOutputLines([
    {
      info: {
        role: 'assistant',
        error: {
          name: 'APIError',
          data: { message: 'The requested model is not available for integrator "copilot-language-server".' },
        },
      },
      parts: [
        { type: 'text', text: 'First line\nSecond line' },
        { type: 'tool', state: { status: 'error', error: 'command failed' } },
      ],
    },
  ]);

  assert.deepEqual(output, [
    'opencode error: The requested model is not available for integrator "copilot-language-server".',
    'First line',
    'Second line',
    'tool failed: command failed',
  ]);
});

test('formats session-level opencode progress events from real event stream shape', () => {
  assert.equal(formatOpenCodeEvent({ type: 'session.status', properties: { sessionID: 'session-1', status: { type: 'busy' } } }, 'session-1'), 'opencode session busy');
  assert.equal(formatOpenCodeEvent({ type: 'session.idle', properties: { sessionID: 'session-1' } }, 'session-1'), 'opencode session idle');
  assert.equal(formatOpenCodeEvent({ type: 'session.error', properties: { sessionID: 'session-1', error: { name: 'APIError', data: { message: 'Insufficient balance' } } } }, 'session-1'), 'opencode error: Insufficient balance');
  assert.equal(formatOpenCodeEvent({ data: { type: 'session.status', properties: { sessionID: 'session-1', status: { type: 'retry', attempt: 2, message: 'rate limited' } } } }, 'session-1'), 'opencode retry 2: rate limited');
});

test('ignores opencode progress events from unrelated sessions', () => {
  assert.equal(formatOpenCodeEvent({ type: 'session.status', properties: { sessionID: 'other-session', status: { type: 'busy' } } }, 'session-1'), null);
  assert.equal(formatOpenCodeEvent({ type: 'message.part.updated', properties: { part: { sessionID: 'other-session', type: 'text', text: 'not ours' } } }, 'session-1'), null);
});

test('formats opencode permission requests as permission progress events', () => {
  const event = parseOpenCodeEvent({
    type: 'permission.updated',
    properties: {
      id: 'per_123',
      type: 'external_directory',
      pattern: ['/tmp/feat-one-worktree/*'],
      sessionID: 'session-1',
      title: 'Access external worktree',
    },
  }, 'session-1');

  assert.equal(event?.kind, 'permission');
  assert.equal(event?.permissionId, 'per_123');
  assert.deepEqual(event?.permissionPatterns, ['/tmp/feat-one-worktree/*']);
  assert.equal(event?.permissionType, 'external_directory');
  assert.equal(event?.permissionTitle, 'Access external worktree');
  assert.match(event?.message ?? '', /external_directory/);
  assert.match(event?.message ?? '', /Access external worktree/);
  assert.match(event?.message ?? '', /\/tmp\/feat-one-worktree\/\*/);
});

test('formats opencode permission replies', () => {
  assert.equal(
    formatOpenCodeEvent({ type: 'permission.replied', properties: { sessionID: 'session-1', permissionID: 'per_123', response: 'once' } }, 'session-1'),
    'opencode permission once (per_123)',
  );
});
