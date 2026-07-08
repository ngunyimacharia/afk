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
  assert.deepEqual(selectableHarnessIds(), ['OpenCode', 'Claude', 'Codex', 'PI']);
  assert.equal(isHarnessId('Codex'), true);
  assert.equal(isSelectableHarnessId('Codex'), true);
  assert.equal(isSelectableHarnessId('OpenCode'), true);
  assert.equal(isSelectableHarnessId('Claude'), true);
  assert.equal(isSelectableHarnessId('PI'), true);
});

test('registry preserves harness display and provider names', () => {
  assert.equal(displayNameForHarness('OpenCode'), 'OpenCode');
  assert.equal(providerNameForHarness('OpenCode'), 'opencode');
  assert.equal(displayNameForHarness('Claude'), 'Claude');
  assert.equal(providerNameForHarness('Claude'), 'claude');
  assert.equal(displayNameForHarness('Codex'), 'Codex');
  assert.equal(providerNameForHarness('Codex'), 'codex');
  assert.equal(displayNameForHarness('PI'), 'PI');
  assert.equal(providerNameForHarness('PI'), 'pi');
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

test('Codex is omitted from selectable harnesses when discovery returns no usable models', async () => {
  const discovery = await discoverAvailableHarnesses(async (harness) =>
    harness === 'Codex' ? [] : await discoverHarnessModels(harness),
  );
  assert.equal(discovery.availableHarnesses.includes('Codex'), false);
  assert.equal(discovery.harnessModelCache.Codex, undefined);
});

test('PI discovery makes PI available to launch', async () => {
  const models = await discoverHarnessModels('PI');
  const modelIds = models.map((model) => model.id);
  assert.ok(modelIds.includes('pi/default'), 'pi/default should be among discovered PI models');

  const discovery = await discoverAvailableHarnesses(async (harness) => (harness === 'PI' ? models : []));
  assert.equal(discovery.availableHarnesses.includes('PI'), true);
  assert.ok(
    discovery.harnessModelCache.PI?.map((model) => model.id).includes('pi/default'),
    'pi/default should be in the harness model cache',
  );
});
