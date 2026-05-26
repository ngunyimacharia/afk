import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  LIGHTWEIGHT_REVIEWER_PROMPT_ID,
  resolveReviewerPrompt,
  resolveReviewerPromptTemplate,
} from '../src/reviewer-prompt-catalog.js';

function promptPath(name: string): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const repoRoot =
    path.basename(here) === 'tests' && path.basename(path.dirname(here)) === 'dist'
      ? path.resolve(here, '../..')
      : path.resolve(here, '..');
  return path.join(repoRoot, 'src', 'prompts', name);
}

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
  const source = readFileSync(promptPath('reviewer-default.md'), 'utf8');
  assert.equal(resolveReviewerPromptTemplate().content, source);
});

test('reviewer prompt enforces strict json and schema examples', () => {
  const source = readFileSync(promptPath('reviewer-default.md'), 'utf8');
  assert.match(source, /You must return \*\*exactly one JSON object\*\*/);
  assert.match(source, /"done":boolean/);
  assert.match(source, /"severity":"minor\|major\|blocker"/);
  assert.match(source, /Clean pass example:/);
  assert.match(source, /Finding example:/);
});

test('reviewer completion criteria require status done and AFK Summary but not reviewer notes', () => {
  const source = readFileSync(promptPath('reviewer-default.md'), 'utf8');
  assert.match(source, /status: done/);
  assert.match(source, /## AFK Summary/);
  assert.doesNotMatch(source, /Reviewer Notes/);
});

test('reviewer prompt instructs exact paths first and avoids broad searches', () => {
  const source = readFileSync(promptPath('reviewer-default.md'), 'utf8');
  assert.match(source, /Use the exact runtime paths provided in the Review Target section first/);
  assert.match(source, /Avoid broad searches, recursive greps, or workspace-wide scans/);
  assert.match(source, /unless the exact paths are missing or inconsistent/);
});

test('lightweight review prompt is explicit, deterministic, and not skip-review', () => {
  const template = resolveReviewerPrompt({ repoRoot: '/tmp', override: LIGHTWEIGHT_REVIEWER_PROMPT_ID });
  assert.equal(template.id, LIGHTWEIGHT_REVIEWER_PROMPT_ID);
  assert.equal(template.path, 'builtin:reviewer-lightweight');
  assert.match(template.content ?? '', /Lightweight/);
  assert.match(template.content ?? '', /NOT a skip-review pass/);
  assert.match(template.content ?? '', /performs focused checks only/);
  assert.match(template.content ?? '', /Ticket status is `done`/);
  assert.match(template.content ?? '', /Verification evidence exists/);
  assert.match(template.content ?? '', /Do NOT perform deep architectural review/);
  assert.match(template.content ?? '', /You must return \*\*exactly one JSON object\*\*/);
  assert.match(template.content ?? '', /"done":boolean/);
});

test('lightweight reviewer prompt matches the markdown prompt source', () => {
  const source = readFileSync(promptPath('reviewer-lightweight.md'), 'utf8');
  const template = resolveReviewerPrompt({ repoRoot: '/tmp', override: LIGHTWEIGHT_REVIEWER_PROMPT_ID });
  assert.equal(template.content, source);
});
