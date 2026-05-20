import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveReviewerPrompt, resolveReviewerPromptTemplate } from '../src/reviewer-prompt-catalog.js';

test('loads the deterministic reviewer prompt', () => {
  const template = resolveReviewerPromptTemplate();
  assert.equal(template.id, 'reviewer-default');
  assert.equal(template.path, 'builtin:reviewer-default');
  assert.match(template.content ?? '', /# Reviewer Prompt/);
  assert.match(template.content ?? '', /Return strict JSON only\./);
  assert.match(template.content ?? '', /"summary"\s*:\s*"string"/);
  assert.match(template.content ?? '', /"findings"\s*:\s*\[/);
  assert.match(template.content ?? '', /"findings":\[\]/);
  assert.match(template.content ?? '', /minor\|major\|blocker/);
  assert.match(template.content ?? '', /"severity":"major"/);
  assert.match(template.content ?? '', /`blocker`/);
});

test('resolves the embedded reviewer prompt outside the target repo', () => {
  const template = resolveReviewerPrompt({ repoRoot: '/tmp/repo-without-afk-prompts' });
  assert.equal(template.id, 'reviewer-default');
  assert.equal(template.path, 'builtin:reviewer-default');
  assert.match(template.content ?? '', /Review the completed ticket in read-only mode/);
  assert.equal(template.path.startsWith('/tmp/repo-without-afk-prompts'), false);
});

test('embedded reviewer prompt matches the markdown prompt source', () => {
  const source = readFileSync(new URL('../src/prompts/reviewer-default.md', import.meta.url), 'utf8');
  assert.equal(resolveReviewerPromptTemplate().content, source);
});

test('reviewer prompt enforces strict json and schema examples', () => {
  const source = readFileSync(new URL('../src/prompts/reviewer-default.md', import.meta.url), 'utf8');
  assert.match(source, /Return strict JSON only\. Do not include markdown fences/);
  assert.match(source, /"severity":"minor\|major\|blocker"/);
  assert.match(source, /Clean pass example:/);
  assert.match(source, /Finding example:/);
});
