import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveReviewerPrompt } from '../src/reviewer-prompt-catalog.js';

test('defaults to the catalog reviewer prompt under src/prompts', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-reviewer-prompt-'));
  const promptsDir = path.join(repoRoot, 'src', 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(path.join(promptsDir, 'reviewer-default.md'), '# default reviewer\n');

  const prompt = resolveReviewerPrompt({ repoRoot });
  assert.equal(prompt.id, 'reviewer-default');
  assert.equal(prompt.path, path.join(promptsDir, 'reviewer-default.md'));
});

test('resolves an override prompt path without falling back to the default', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-reviewer-prompt-override-'));
  const overridePath = path.join(repoRoot, 'src', 'prompts', 'reviewer-special.md');
  mkdirSync(path.dirname(overridePath), { recursive: true });
  writeFileSync(overridePath, '# override reviewer\n');

  const prompt = resolveReviewerPrompt({ repoRoot, override: path.join('src', 'prompts', 'reviewer-special.md') });
  assert.equal(prompt.id, path.join('src', 'prompts', 'reviewer-special.md'));
  assert.equal(prompt.path, overridePath);
});

test('fails clearly when the override prompt does not exist', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'afk-reviewer-prompt-missing-'));
  assert.throws(() => resolveReviewerPrompt({ repoRoot, override: 'missing-reviewer.md' }), /Reviewer prompt not found/);
});
