import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelSelector } from '../src/model-selector.js';

test('selects model', async () => {
  const selector = new ModelSelector(async () => [{ id: 'm1' }], async (models) => models[0]);
  assert.equal((await selector.selectModel()).id, 'm1');
});

test('fails when cancelled', async () => {
  const selector = new ModelSelector(async () => [{ id: 'm1' }], async () => null);
  await assert.rejects(() => selector.selectModel(), /No model selected/);
});
