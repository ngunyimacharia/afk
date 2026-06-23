import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  DEFAULT_ACTIVE_TOOL_STALE_TIMEOUT_MS,
  DEFAULT_MAX_STALE_RECOVERIES,
  DEFAULT_STALE_PROGRESS_TIMEOUT_MS,
  discoverClaudeModels,
  parseClaudeCodeEvent,
  resetClaudeCodeExecutablePathCache,
  resolveClaudeRepoConfig,
} from '../src/claude-code.js';
import { buildStaleRecoveryPrompt } from '../src/opencode.js';
import { detectClaudeCodeFailure } from '../src/provider-failure.js';

function makeTempRepo(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'afk-claude-test-'));
}

function writeClaudeSettings(repoRoot: string, env: Record<string, string>): void {
  const dir = path.join(repoRoot, '.claude');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'settings.local.json'), JSON.stringify({ env }), 'utf8');
}

function cleanupRepo(repoRoot: string): void {
  try {
    rmSync(repoRoot, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

describe('resolveClaudeRepoConfig', () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;

  test('reads Kimi override from .claude/settings.local.json', () => {
    const repoRoot = makeTempRepo();
    try {
      writeClaudeSettings(repoRoot, {
        ANTHROPIC_API_KEY: 'sk-kimi-test',
        ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
      });
      const config = resolveClaudeRepoConfig(repoRoot);
      assert.equal(config.source, 'file');
      assert.equal(config.isKimi, true);
      assert.equal(config.env.ANTHROPIC_API_KEY, 'sk-kimi-test');
      assert.equal(config.env.ANTHROPIC_BASE_URL, 'https://api.kimi.com/coding/');
    } finally {
      cleanupRepo(repoRoot);
    }
  });

  test('file env overrides process.env', () => {
    const repoRoot = makeTempRepo();
    try {
      process.env.ANTHROPIC_API_KEY = 'shell-key';
      writeClaudeSettings(repoRoot, { ANTHROPIC_API_KEY: 'file-key' });
      const config = resolveClaudeRepoConfig(repoRoot);
      assert.equal(config.env.ANTHROPIC_API_KEY, 'file-key');
    } finally {
      cleanupRepo(repoRoot);
      if (originalApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = originalApiKey;
      }
    }
  });

  test('detects Anthropic config from file', () => {
    const repoRoot = makeTempRepo();
    try {
      writeClaudeSettings(repoRoot, { ANTHROPIC_API_KEY: 'sk-ant-test' });
      const config = resolveClaudeRepoConfig(repoRoot);
      assert.equal(config.source, 'file');
      assert.equal(config.isKimi, false);
    } finally {
      cleanupRepo(repoRoot);
    }
  });

  test('falls back to executable detection when file is missing', () => {
    const repoRoot = makeTempRepo();
    try {
      resetClaudeCodeExecutablePathCache();
      const config = resolveClaudeRepoConfig(repoRoot);
      // Result depends on whether `claude` is installed in the test environment.
      assert.ok(config.source === 'executable' || config.source === 'none');
    } finally {
      cleanupRepo(repoRoot);
    }
  });

  test('restores original env', () => {
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
    if (originalBaseUrl === undefined) {
      delete process.env.ANTHROPIC_BASE_URL;
    } else {
      process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    }
    assert.ok(true);
  });
});

describe('discoverClaudeModels', () => {
  test('returns Kimi model when file has Kimi base URL', async () => {
    const repoRoot = makeTempRepo();
    try {
      writeClaudeSettings(repoRoot, {
        ANTHROPIC_API_KEY: 'sk-kimi-test',
        ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
      });
      const models = await discoverClaudeModels(repoRoot);
      assert.equal(models.length, 1);
      assert.equal(models[0].id, 'kimi/kimi-for-coding');
      assert.equal(models[0].label, 'Kimi for Coding');
    } finally {
      cleanupRepo(repoRoot);
    }
  });

  test('returns Anthropic models when file has non-Kimi config', async () => {
    const repoRoot = makeTempRepo();
    try {
      writeClaudeSettings(repoRoot, { ANTHROPIC_API_KEY: 'sk-ant-test' });
      const models = await discoverClaudeModels(repoRoot);
      assert.deepEqual(
        models.map((model) => model.id),
        ['anthropic/claude-opus-4', 'anthropic/claude-sonnet-4', 'anthropic/claude-haiku-4'],
      );
    } finally {
      cleanupRepo(repoRoot);
    }
  });

  test('returns Anthropic models when Claude is installed and no file exists', async () => {
    const repoRoot = makeTempRepo();
    try {
      const models = await discoverClaudeModels(repoRoot, { isClaudeCodeInstalled: () => true });
      assert.equal(models.length, 3);
      assert.equal(models[0].id, 'anthropic/claude-opus-4');
    } finally {
      cleanupRepo(repoRoot);
    }
  });

  test('returns empty array when no file and Claude is not installed', async () => {
    const repoRoot = makeTempRepo();
    try {
      const models = await discoverClaudeModels(repoRoot, { isClaudeCodeInstalled: () => false });
      assert.equal(models.length, 0);
    } finally {
      cleanupRepo(repoRoot);
    }
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

describe('stale detection defaults', () => {
  test('base timeout is 15 minutes, active-tool timeout is 20 minutes, max recoveries is 3', () => {
    assert.equal(DEFAULT_STALE_PROGRESS_TIMEOUT_MS, 15 * 60_000);
    assert.equal(DEFAULT_ACTIVE_TOOL_STALE_TIMEOUT_MS, 20 * 60_000);
    assert.equal(DEFAULT_MAX_STALE_RECOVERIES, 3);
  });

  test('recovery prompt names active tool and instructs progress check', () => {
    const prompt = buildStaleRecoveryPrompt('Original prompt', 1, 3, 'Claude', 'git');
    assert.match(prompt, /stale recovery attempt 1\/3/);
    assert.match(prompt, /stale while: git/);
    assert.match(prompt, /making progress/i);
    assert.match(prompt, /report a blocker/i);
  });
});
