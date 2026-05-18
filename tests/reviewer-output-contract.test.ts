import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideReviewOutcome, parseReviewerOutput } from '../src/reviewer-output-contract.js';

test('parses reviewer JSON payloads and normalizes severities', () => {
  const review = parseReviewerOutput(
    '```json\n' +
      '{\n' +
      '  "summary": "Looks good overall",\n' +
      '  "findings": [\n' +
      '    {"severity": "MINOR", "summary": "Small wording issue"},\n' +
      '    {"severity": "major", "message": "Need a guard rail", "detail": "This can break retries"},\n' +
      '    {"severity": "blocker", "finding": "Must not ship this"}\n' +
      '  ]\n' +
      '}\n' +
      '```',
  );

  assert.equal(review.malformed, false);
  assert.equal(review.summary, 'Looks good overall');
  assert.deepEqual(review.findings, [
    { severity: 'minor', summary: 'Small wording issue' },
    { severity: 'major', summary: 'Need a guard rail', detail: 'This can break retries' },
    { severity: 'blocker', summary: 'Must not ship this' },
  ]);
});

test('falls back safely for malformed reviewer output', () => {
  const review = parseReviewerOutput('not valid json');

  assert.equal(review.malformed, true);
  assert.equal(review.summary, 'Malformed reviewer output');
  assert.deepEqual(review.findings, [{ severity: 'major', summary: 'Reviewer output could not be parsed' }]);
});

test('approves minor-only findings', () => {
  const review = parseReviewerOutput({
    summary: 'Minor cleanup only',
    findings: [{ severity: 'minor', summary: 'Rename one variable' }],
  });

  const decision = decideReviewOutcome({ review, cycleCount: 0, maxCycles: 2 });

  assert.equal(decision.outcome, 'approve');
  assert.equal(decision.reason, 'Reviewer findings are minor only');
});

test('loops on major or blocker findings until the cycle cap is reached', () => {
  const majorReview = parseReviewerOutput({
    summary: 'Needs a fix',
    findings: [{ severity: 'major', summary: 'Missing guard' }],
  });
  const blockerReview = parseReviewerOutput({
    summary: 'Cannot approve',
    findings: [{ severity: 'blocker', summary: 'Data loss risk' }],
  });

  const loopDecision = decideReviewOutcome({ review: majorReview, cycleCount: 1, maxCycles: 3 });
  const handoffDecision = decideReviewOutcome({ review: blockerReview, cycleCount: 3, maxCycles: 3 });

  assert.equal(loopDecision.outcome, 'loop-required');
  assert.equal(loopDecision.reason, 'Reviewer findings include major or blocker severity');
  assert.equal(handoffDecision.outcome, 'handoff-required');
  assert.equal(handoffDecision.reason, 'Reviewer cycle cap reached with unresolved major findings');
});
