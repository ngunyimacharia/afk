import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SummaryPresenceGate } from '../src/summary-presence-gate.js';

test('detects AFK summary blocks', () => {
  const gate = new SummaryPresenceGate();
  assert.equal(gate.hasSummary('## AFK Summary\nStatus: done\n'), true);
  assert.equal(gate.hasSummary('## Notes\nStatus: done\n'), false);
});
