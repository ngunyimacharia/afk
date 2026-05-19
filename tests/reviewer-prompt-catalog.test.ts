import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveReviewerPrompt, resolveReviewerPromptTemplate } from '../src/reviewer-prompt-catalog.js';

test('loads the deterministic reviewer prompt', () => {
  const template = resolveReviewerPromptTemplate();
  assert.equal(template.id, 'reviewer-default');
  assert.equal(template.path, 'builtin:reviewer-default');
  assert.match(template.content ?? '', /# Reviewer Prompt/);
});

test('resolves the embedded reviewer prompt outside the target repo', () => {
  const template = resolveReviewerPrompt({ repoRoot: '/tmp/repo-without-afk-prompts' });
  assert.equal(template.id, 'reviewer-default');
  assert.equal(template.path, 'builtin:reviewer-default');
  assert.match(template.content ?? '', /Evaluate the completed ticket in read-only mode/);
  assert.equal(template.path.startsWith('/tmp/repo-without-afk-prompts'), false);
});

test('embedded reviewer prompt matches the markdown prompt source', () => {
  const source = readFileSync(new URL('../src/prompts/reviewer-default.md', import.meta.url), 'utf8');
  assert.equal(resolveReviewerPromptTemplate().content, source);
});
