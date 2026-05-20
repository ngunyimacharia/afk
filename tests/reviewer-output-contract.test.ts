import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideReviewOutcome, parseReviewerOutput } from '../src/reviewer-output-contract.js';

test('parses reviewer JSON output and normalizes severity fields', () => {
  const review = parseReviewerOutput([
    '```json',
    '{',
    '  "summary": "Looks good overall",',
    '  "findings": [',
    '    {',
    '      "severity": "MINOR",',
    '      "title": "Nit",',
    '      "detail": "Consider renaming this variable.",',
    '      "suggested_fix": "Use a clearer name"',
    '    },',
    '    {',
    '      "severity": "blocker",',
    '      "title": "Broken flow",',
    '      "detail": "The retry path can drop work."',
    '    }',
    '  ]',
    '}',
    '```',
  ].join('\n'));

  assert.equal(review.fallback, false);
  assert.equal(review.summary, 'Looks good overall');
  assert.equal(review.highestSeverity, 'blocker');
  assert.deepEqual(review.findings, [
    {
      severity: 'minor',
      title: 'Nit',
      detail: 'Consider renaming this variable.',
      suggestedFix: 'Use a clearer name',
    },
    {
      severity: 'blocker',
      title: 'Broken flow',
      detail: 'The retry path can drop work.',
    },
  ]);
});

test('falls back safely when reviewer output cannot be parsed', () => {
  const review = parseReviewerOutput('this is not structured reviewer output');

  assert.equal(review.fallback, true);
  assert.equal(review.highestSeverity, 'major');
  assert.equal(review.summary, 'Malformed reviewer output');
  assert.equal(review.failureKind, 'malformed-output');
  assert.deepEqual(review.findings, []);
  assert.match(review.raw, /this is not structured reviewer output/);
});

test('approves minor-only feedback and loops on high severity until the cap', () => {
  const minorReview = parseReviewerOutput({
    summary: 'Minor polish only',
    findings: [{ severity: 'minor', title: 'Style', detail: 'Spacing could be improved.' }],
  });
  const majorReview = parseReviewerOutput({
    summary: 'Needs work',
    findings: [{ severity: 'major', title: 'Bug', detail: 'This breaks on empty input.' }],
  });

  assert.equal(decideReviewOutcome(minorReview, { cycle: 1 }).decision, 'approve');
  assert.equal(decideReviewOutcome(majorReview, { cycle: 1, maxCycles: 3 }).decision, 'loop');
  assert.equal(decideReviewOutcome(majorReview, { cycle: 3, maxCycles: 3 }).decision, 'needs-human');
});
