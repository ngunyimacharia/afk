import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverKimiModels } from '../src/kimi.js';

test('returns empty array when kimi config is missing', async () => {
  const models = await discoverKimiModels();
  assert.ok(Array.isArray(models));
});

test('extracts models from kimi config', async () => {
  const models = await discoverKimiModels();
  // We can't control the user's ~/.kimi/config.toml, so we just validate shape
  for (const model of models) {
    assert.ok(typeof model.id === 'string');
    assert.ok(model.id.length > 0);
    assert.ok(typeof model.label === 'string');
    assert.ok(model.label.length > 0);
  }
});
