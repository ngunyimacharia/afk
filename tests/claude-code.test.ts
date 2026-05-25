import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { discoverClaudeKimiModels, parseClaudeCodeEvent } from '../src/claude-code.js';
import { detectClaudeCodeFailure } from '../src/provider-failure.js';

describe('discoverClaudeKimiModels', () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  test('returns model when ANTHROPIC_API_KEY is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const models = await discoverClaudeKimiModels();
    assert.equal(models.length, 1);
    assert.equal(models[0].id, 'kimi/kimi-for-coding');
    assert.equal(models[0].label, 'Kimi for Coding');
  });

  test('returns empty array when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const models = await discoverClaudeKimiModels();
    assert.equal(models.length, 0);
  });

  test('restore original env', () => {
    if (originalKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
    assert.ok(true);
  });
});

describe('parseClaudeCodeEvent', () => {
  test('returns null for non-object input', () => {
    assert.equal(parseClaudeCodeEvent(null), null);
    assert.equal(parseClaudeCodeEvent('string'), null);
    assert.equal(parseClaudeCodeEvent(42), null);
  });

  test('parses assistant message', () => {
    const event = parseClaudeCodeEvent({
      type: 'assistant',
      session_id: 'sess-1',
      message: { content: [{ text: 'hello world' }] },
    });
    assert.equal(event?.kind, 'message');
    assert.equal(event?.message, 'hello world');
    assert.equal(event?.activity, 'assistant');
    assert.equal(event?.sessionId, 'sess-1');
  });

  test('parses assistant message with thinking block', () => {
    const event = parseClaudeCodeEvent({
      type: 'assistant',
      session_id: 'sess-1',
      message: { content: [{ thinking: 'deep thought' }] },
    });
    assert.equal(event?.kind, 'message');
    assert.equal(event?.message, 'deep thought');
    assert.equal(event?.activity, 'assistant');
  });

  test('returns null for assistant message with empty content', () => {
    const event = parseClaudeCodeEvent({
      type: 'assistant',
      session_id: 'sess-1',
      message: { content: [] },
    });
    assert.equal(event, null);
  });

  test('parses tool_progress message', () => {
    const event = parseClaudeCodeEvent({
      type: 'tool_progress',
      session_id: 'sess-2',
      tool_name: 'bash',
    });
    assert.equal(event?.kind, 'message');
    assert.equal(event?.message, 'tool bash running');
    assert.equal(event?.activity, 'tool');
    assert.equal(event?.toolName, 'bash');
    assert.equal(event?.toolStatus, 'running');
    assert.equal(event?.sessionId, 'sess-2');
  });

  test('parses result error message', () => {
    const event = parseClaudeCodeEvent({
      type: 'result',
      session_id: 'sess-3',
      subtype: 'error',
    });
    assert.equal(event?.kind, 'message');
    assert.equal(event?.message, 'claude result error: error');
    assert.equal(event?.activity, 'session');
    assert.equal(event?.sessionId, 'sess-3');
  });

  test('returns null for result success message', () => {
    const event = parseClaudeCodeEvent({
      type: 'result',
      session_id: 'sess-3',
      subtype: 'success',
    });
    assert.equal(event, null);
  });

  test('parses system compact_boundary message', () => {
    const event = parseClaudeCodeEvent({
      type: 'system',
      session_id: 'sess-4',
      subtype: 'compact_boundary',
    });
    assert.equal(event?.kind, 'message');
    assert.equal(event?.message, 'claude context compaction started');
    assert.equal(event?.activity, 'session');
    assert.equal(event?.sessionId, 'sess-4');
  });

  test('parses system session_state_changed message', () => {
    const event = parseClaudeCodeEvent({
      type: 'system',
      session_id: 'sess-5',
      subtype: 'session_state_changed',
      state: 'paused',
    });
    assert.equal(event?.kind, 'message');
    assert.equal(event?.message, 'claude session paused');
    assert.equal(event?.activity, 'session');
  });

  test('parses system permission_denied message', () => {
    const event = parseClaudeCodeEvent({
      type: 'system',
      session_id: 'sess-6',
      subtype: 'permission_denied',
      tool_name: 'bash',
      message: 'not allowed',
    });
    assert.equal(event?.kind, 'permission');
    assert.equal(event?.message, 'claude permission denied: bash - not allowed');
    assert.equal(event?.activity, 'permission');
    assert.equal(event?.sessionId, 'sess-6');
  });

  test('returns null for unknown system subtype', () => {
    const event = parseClaudeCodeEvent({
      type: 'system',
      session_id: 'sess-7',
      subtype: 'unknown_subtype',
    });
    assert.equal(event, null);
  });

  test('returns null for unknown message type', () => {
    const event = parseClaudeCodeEvent({
      type: 'unknown',
      session_id: 'sess-8',
    });
    assert.equal(event, null);
  });
});

describe('detectClaudeCodeFailure', () => {
  test('detects claude error', () => {
    const failure = detectClaudeCodeFailure(['ok', 'claude error: something broke']);
    assert.equal(failure, 'claude error: something broke');
  });

  test('detects claude agent error', () => {
    const failure = detectClaudeCodeFailure(['claude agent error: auth failed']);
    assert.equal(failure, 'claude agent error: auth failed');
  });

  test('detects session stale', () => {
    const failure = detectClaudeCodeFailure(['session stale after 3 recovery attempts']);
    assert.equal(failure, 'session stale after 3 recovery attempts');
  });

  test('detects overloaded_error', () => {
    const failure = detectClaudeCodeFailure(['overloaded_error: server busy']);
    assert.equal(failure, 'overloaded_error: server busy');
  });

  test('detects rate_limit_error', () => {
    const failure = detectClaudeCodeFailure(['rate_limit_error: too many requests']);
    assert.equal(failure, 'rate_limit_error: too many requests');
  });

  test('detects context overflow', () => {
    const failure = detectClaudeCodeFailure(['context overflow']);
    assert.equal(failure, 'context overflow');
  });

  test('returns null when no failure present', () => {
    const failure = detectClaudeCodeFailure(['all good', 'success']);
    assert.equal(failure, null);
  });

  test('returns null for empty output', () => {
    const failure = detectClaudeCodeFailure([]);
    assert.equal(failure, null);
  });
});
