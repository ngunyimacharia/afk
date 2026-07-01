import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  discoverAvailableHarnesses,
  discoverHarnessModels,
  displayNameForHarness,
  isHarnessId,
  isSelectableHarnessId,
  providerNameForHarness,
  selectableHarnessIds,
} from '../src/harness-registry.js';

test('registry exposes only current selectable harnesses', () => {
  assert.deepEqual(selectableHarnessIds(), ['OpenCode', 'Claude', 'Codex']);
  assert.equal(isHarnessId('Codex'), true);
  assert.equal(isSelectableHarnessId('Codex'), true);
  assert.equal(isSelectableHarnessId('OpenCode'), true);
  assert.equal(isSelectableHarnessId('Claude'), true);
});

test('registry preserves harness display and provider names', () => {
  assert.equal(displayNameForHarness('OpenCode'), 'OpenCode');
  assert.equal(providerNameForHarness('OpenCode'), 'opencode');
  assert.equal(displayNameForHarness('Claude'), 'Claude');
  assert.equal(providerNameForHarness('Claude'), 'claude');
  assert.equal(displayNameForHarness('Codex'), 'Codex');
  assert.equal(providerNameForHarness('Codex'), 'codex');
});

test('Codex discovery makes Codex available to launch', async () => {
  const models = await discoverHarnessModels('Codex');
  assert.deepEqual(
    models.map((model) => model.id),
    ['codex/default'],
  );

  const discovery = await discoverAvailableHarnesses(async (harness) => (harness === 'Codex' ? models : []));
  assert.equal(discovery.availableHarnesses.includes('Codex'), true);
  assert.deepEqual(
    discovery.harnessModelCache.Codex?.map((model) => model.id),
    ['codex/default'],
  );
});
