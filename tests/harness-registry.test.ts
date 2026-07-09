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

test('registry exposes only PI as the selectable harness', () => {
  assert.deepEqual(selectableHarnessIds(), ['PI']);
  assert.equal(isHarnessId('PI'), true);
  assert.equal(isSelectableHarnessId('PI'), true);
});

test('registry preserves PI harness display and provider names', () => {
  assert.equal(displayNameForHarness('PI'), 'PI');
  assert.equal(providerNameForHarness('PI'), 'pi');
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
