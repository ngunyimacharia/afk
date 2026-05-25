import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveReviewerPrompt, resolveReviewerPromptTemplate } from '../src/reviewer-prompt-catalog.js';

test('loads the deterministic reviewer prompt', () => {
  const template = resolveReviewerPromptTemplate();
  assert.equal(template.id, 'reviewer-default');
  assert.equal(template.path, 'builtin:reviewer-default');
  assert.match(template.content ?? '', /# Reviewer Prompt/);
  assert.match(template.content ?? '', /You must return \*\*exactly one JSON object\*\*/);
  assert.match(template.content ?? '', /"done":boolean/);
  assert.match(template.content ?? '', /"summary"\s*:\s*"string"/);
  assert.match(template.content ?? '', /"findings"\s*:\s*\[/);
  assert.match(template.content ?? '', /"findings":\[\]/);
  assert.match(template.content ?? '', /minor\|major\|blocker/);
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
  assert.match(source, /You must return \*\*exactly one JSON object\*\*/);
  assert.match(source, /"done":boolean/);
  assert.match(source, /"severity":"minor\|major\|blocker"/);
  assert.match(source, /Clean pass example:/);
  assert.match(source, /Finding example:/);
});

test('reviewer completion criteria require status done and AFK Summary but not reviewer notes', () => {
  const source = readFileSync(new URL('../src/prompts/reviewer-default.md', import.meta.url), 'utf8');
  assert.match(source, /status: done/);
  assert.match(source, /## AFK Summary/);
  assert.doesNotMatch(source, /Reviewer Notes/);
});
