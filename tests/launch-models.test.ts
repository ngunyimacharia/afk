import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveLaunchModelSelection } from '../src/launch-models.js';

test('resolves execution and reviewer models independently', () => {
  const selection = resolveLaunchModelSelection({ executionModelId: 'exec-1', reviewerModelId: 'review-1' });
  assert.equal(selection.executionModel.id, 'exec-1');
  assert.equal(selection.reviewerModel.id, 'review-1');
});

test('keeps the reviewer model default independent from execution overrides', () => {
  const selection = resolveLaunchModelSelection({ executionModelId: 'exec-1' });
  assert.equal(selection.executionModel.id, 'exec-1');
  assert.equal(selection.reviewerModel.id, 'reviewer-default-model');
});

test('keeps the execution model default independent from reviewer overrides', () => {
  const selection = resolveLaunchModelSelection({ reviewerModelId: 'review-1' });
  assert.equal(selection.executionModel.id, 'default-model');
  assert.equal(selection.reviewerModel.id, 'review-1');
});
