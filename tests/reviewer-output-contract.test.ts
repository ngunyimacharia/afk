import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideReviewOutcome, parseReviewerOutput } from '../src/reviewer-output-contract.js';
import { resolveReviewerPromptTemplate } from '../src/reviewer-prompt-catalog.js';

test('parses reviewer JSON output and normalizes severity fields', () => {
  const review = parseReviewerOutput(
    [
      '```json',
      '{',
      '  "done": false,',
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
    ].join('\n'),
  );

  assert.equal(review.fallback, false);
  assert.equal(review.done, false);
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

test('parses raw JSON output without code fences', () => {
  const review = parseReviewerOutput(
    '{"done":false,"summary":"No blockers","findings":[{"severity":"minor","title":"Small polish","detail":"Optional rename."}]}',
  );

  assert.equal(review.fallback, false);
  assert.equal(review.done, false);
  assert.equal(review.summary, 'No blockers');
  assert.equal(review.highestSeverity, 'minor');
  assert.equal(review.findings.length, 1);
});

test('falls back safely when reviewer output cannot be parsed', () => {
  const review = parseReviewerOutput('this is not structured reviewer output');

  assert.equal(review.fallback, true);
  assert.equal(review.done, false);
  assert.equal(review.highestSeverity, 'major');
  assert.equal(review.summary, 'Malformed reviewer output');
  assert.equal(review.failureKind, 'malformed-output');
  assert.deepEqual(review.findings, []);
  assert.match(review.raw, /this is not structured reviewer output/);
});

test('falls back when done field is missing', () => {
  const review = parseReviewerOutput(
    '{"summary":"No blockers","findings":[{"severity":"minor","title":"Small polish","detail":"Optional rename."}]}',
  );

  assert.equal(review.fallback, true);
  assert.equal(review.done, false);
});

test('falls back when done is true but findings are present', () => {
  const review = parseReviewerOutput(
    '{"done":true,"summary":"Looks good","findings":[{"severity":"minor","title":"Nit","detail":"Consider renaming."}]}',
  );

  assert.equal(review.fallback, true);
  assert.equal(review.done, false);
});

test('parses JSON object embedded in plain-text reviewer output', () => {
  const review = parseReviewerOutput(
    [
      'opencode session prompt completed',
      'review payload follows',
      '{"done":false,"summary":"Needs updates","findings":[{"severity":"major","title":"Missing test","detail":"Add coverage for retry flow."}]}',
    ].join('\n'),
  );

  assert.equal(review.fallback, false);
  assert.equal(review.done, false);
  assert.equal(review.summary, 'Needs updates');
  assert.equal(review.highestSeverity, 'major');
  assert.deepEqual(review.findings, [
    {
      severity: 'major',
      title: 'Missing test',
      detail: 'Add coverage for retry flow.',
    },
  ]);
});

test('uses final valid reviewer JSON when opencode output includes echoed prompt examples', () => {
  const raw = [
    resolveReviewerPromptTemplate().content,
    '**Reviewer reasoning omitted**',
    '{"done":false,"summary":"Major issue found.","findings":[{"severity":"major","title":"Retry bypassed","detail":"Provider failures returned as failed results are not retried."}]}',
  ].join('\n');

  const review = parseReviewerOutput(raw);

  assert.equal(review.fallback, false);
  assert.equal(review.done, false);
  assert.equal(review.summary, 'Major issue found.');
  assert.equal(review.highestSeverity, 'major');
  assert.deepEqual(review.findings, [
    {
      severity: 'major',
      title: 'Retry bypassed',
      detail: 'Provider failures returned as failed results are not retried.',
    },
  ]);
});

test('prefers final standalone reviewer JSON over echoed clean-pass examples', () => {
  const raw = [
    resolveReviewerPromptTemplate().content,
    'The previous reviewer response was malformed. Return JSON only with this exact shape: {"done":boolean,"summary":"string","findings":[{"severity":"minor|major|blocker","title":"string","detail":"string"}]}.',
    '{"done":true,"summary":"Reviewed implementation and tests; no material issues found.","findings":[]}',
  ].join('\n');

  const review = parseReviewerOutput(raw);

  assert.equal(review.fallback, false);
  assert.equal(review.done, true);
  assert.equal(review.summary, 'Reviewed implementation and tests; no material issues found.');
  assert.deepEqual(review.findings, []);
});

test('approves done:true with no findings and loops on done:false', () => {
  const doneReview = parseReviewerOutput({
    done: true,
    summary: 'Clean pass',
    findings: [],
  });
  const notDoneReview = parseReviewerOutput({
    done: false,
    summary: 'Needs work',
    findings: [{ severity: 'major', title: 'Bug', detail: 'This breaks on empty input.' }],
  });

  assert.equal(decideReviewOutcome(doneReview, { cycle: 1 }).decision, 'approve');
  assert.equal(decideReviewOutcome(notDoneReview, { cycle: 1, maxCycles: 3 }).decision, 'loop');
  assert.equal(decideReviewOutcome(notDoneReview, { cycle: 3, maxCycles: 3 }).decision, 'needs-human');
});

test('approves clean reviewer output with empty findings and done:true', () => {
  const cleanReview = parseReviewerOutput({ done: true, summary: 'No issues found', findings: [] });

  assert.equal(cleanReview.fallback, false);
  assert.equal(cleanReview.done, true);
  assert.equal(cleanReview.highestSeverity, 'minor');
  assert.deepEqual(cleanReview.findings, []);
  assert.equal(decideReviewOutcome(cleanReview, { cycle: 1 }).decision, 'approve');
});

test('loops on done:false even with minor findings', () => {
  const minorReview = parseReviewerOutput({
    done: false,
    summary: 'Minor polish only',
    findings: [{ severity: 'minor', title: 'Style', detail: 'Spacing could be improved.' }],
  });

  assert.equal(decideReviewOutcome(minorReview, { cycle: 1 }).decision, 'loop');
});

test('loops on done:false with empty findings (ticket incomplete)', () => {
  const incompleteReview = parseReviewerOutput({
    done: false,
    summary: 'Ticket incomplete: missing AFK Summary',
    findings: [],
  });

  assert.equal(incompleteReview.fallback, false);
  assert.equal(incompleteReview.done, false);
  assert.equal(decideReviewOutcome(incompleteReview, { cycle: 1 }).decision, 'loop');
});

test('parses single-object arrays and common finding aliases', () => {
  const review = parseReviewerOutput(
    JSON.stringify([
      {
        done: false,
        issues: [{ severity: 'major', title: 'Missing guard', description: 'The save path lacks an offline guard.' }],
      },
    ]),
  );

  assert.equal(review.fallback, false);
  assert.equal(review.done, false);
  assert.equal(review.summary, 'Reviewer findings parsed.');
  assert.deepEqual(review.findings, [
    { severity: 'major', title: 'Missing guard', detail: 'The save path lacks an offline guard.' },
  ]);
});

test('does not accept prompt-disallowed legacy severities', () => {
  for (const severity of ['critical', 'high', 'medium', 'low']) {
    const review = parseReviewerOutput({
      done: false,
      summary: 'legacy severity',
      findings: [{ severity, title: 'Issue', detail: 'Detail' }],
    });
    assert.equal(review.fallback, true);
  }
});
