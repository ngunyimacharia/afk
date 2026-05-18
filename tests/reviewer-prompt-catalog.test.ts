import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveReviewerPromptTemplate } from '../src/reviewer-prompt-catalog.js';

test('loads the deterministic reviewer prompt', () => {
  const template = resolveReviewerPromptTemplate();
  assert.equal(template.id, 'reviewer-default');
  assert.equal(template.path, 'src/prompts/reviewer-default.md');
});
