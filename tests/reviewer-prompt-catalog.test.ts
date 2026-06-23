import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CONFLICT_RESOLUTION_PROMPT_ID,
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
  assert.match(template.content ?? '', /finalization reviewer/);
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
  assert.match(source, /Emit the JSON object as a single line/);
});

test('reviewer completion criteria require AFK Summary with Reviewer Notes and ticket finalization', () => {
  const source = readFileSync(promptPath('reviewer-default.md'), 'utf8');
  assert.match(source, /status: done/);
  assert.match(source, /## AFK Summary/);
  assert.match(source, /Reviewer Notes/);
  assert.match(source, /Limit active review work to three minutes/);
  assert.match(source, /Do NOT require fixes for pre-existing environment failures/);
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
  assert.match(template.content ?? '', /Limit active review work to three minutes/);
  assert.match(template.content ?? '', /Do NOT require fixes for pre-existing environment failures/);
  assert.match(template.content ?? '', /Emit the JSON object as a single line/);
});

test('lightweight reviewer prompt instructs exact paths first and avoids broad searches', () => {
  const source = readFileSync(promptPath('reviewer-lightweight.md'), 'utf8');
  assert.match(source, /Use the exact runtime paths provided in the Review Target section first/);
  assert.match(source, /Avoid broad searches, recursive greps, or workspace-wide scans/);
  assert.match(source, /unless the exact paths are missing or inconsistent/);
});

test('lightweight reviewer prompt matches the markdown prompt source', () => {
  const source = readFileSync(promptPath('reviewer-lightweight.md'), 'utf8');
  const template = resolveReviewerPrompt({ repoRoot: '/tmp', override: LIGHTWEIGHT_REVIEWER_PROMPT_ID });
  assert.equal(template.content, source);
});

test('default reviewer prompt does not require static check result inspection', () => {
  const source = readFileSync(promptPath('reviewer-default.md'), 'utf8');
  assert.doesNotMatch(source, /static check results/i);
  assert.doesNotMatch(source, /If all static checks passed/i);
  assert.doesNotMatch(source, /If any static check failed/i);
});

test('lightweight reviewer prompt does not require static check result inspection', () => {
  const source = readFileSync(promptPath('reviewer-lightweight.md'), 'utf8');
  assert.doesNotMatch(source, /Static check results are inspected/i);
  assert.doesNotMatch(source, /If all passed, confirm this/i);
  assert.doesNotMatch(source, /If any failed/i);
});

test('conflict resolution prompt is resolvable and has expected schema', () => {
  const template = resolveReviewerPrompt({ repoRoot: '/tmp', override: CONFLICT_RESOLUTION_PROMPT_ID });
  assert.equal(template.id, CONFLICT_RESOLUTION_PROMPT_ID);
  assert.equal(template.path, 'builtin:reviewer-conflict-resolution');
  assert.match(template.content ?? '', /# Conflict Resolution Prompt/);
  assert.match(template.content ?? '', /"done":boolean/);
  assert.match(template.content ?? '', /"summary"\s*:\s*"string"/);
  assert.match(template.content ?? '', /"conflictPaths"/);
  assert.match(template.content ?? '', /"findings"\s*:\s*\[/);
  assert.match(template.content ?? '', /minor\|major\|blocker/);
});

test('conflict resolution prompt allows git state commands needed for resolution', () => {
  const source = readFileSync(promptPath('conflict-resolution.md'), 'utf8');
  assert.match(source, /You MAY run local Git state commands needed for resolution/);
  assert.match(source, /git status/);
  assert.match(source, /conflict-stage inspection/);
  assert.match(source, /git add/);
  assert.match(source, /git merge --continue/);
  assert.match(source, /git commit/);
});

test('conflict resolution prompt forbids dangerous or unrelated operations', () => {
  const source = readFileSync(promptPath('conflict-resolution.md'), 'utf8');
  assert.match(source, /Do NOT push/);
  assert.match(source, /force-reset unrelated work/);
  assert.match(source, /change unrelated branches/);
  assert.match(source, /edit unrelated files/);
  assert.match(source, /Do NOT create new files/);
  assert.match(source, /delete files/);
  assert.ok(source.includes('modify `.scratch/` artifacts'));
});

test('conflict resolution prompt matches the markdown prompt source', () => {
  const source = readFileSync(promptPath('conflict-resolution.md'), 'utf8');
  const template = resolveReviewerPrompt({ repoRoot: '/tmp', override: CONFLICT_RESOLUTION_PROMPT_ID });
  assert.equal(template.content, source);
});
