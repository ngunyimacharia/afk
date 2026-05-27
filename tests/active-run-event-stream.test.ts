import assert from 'node:assert/strict';
import test from 'node:test';
import { ActiveRunEventStream } from '../src/active-run-event-stream.js';
import { mkRepoLocalTempDir } from './helpers/temp-repo.js';

test('active run event stream appends and replays progress events', () => {
  const repoRoot = mkRepoLocalTempDir('active-run-stream-');
  const stream = new ActiveRunEventStream(repoRoot, 'run-1');

  stream.appendProgress({ ticketLabel: 'feature/01', kind: 'message', message: 'started' });
  stream.appendProgress({ ticketLabel: 'feature/01', kind: 'message', message: 'done' });

  const first = stream.readFromOffset(0);
  assert.equal(first.events.length, 2);
  assert.equal(first.events[0]?.message, 'started');
  assert.equal(first.events[1]?.message, 'done');

  const second = stream.readFromOffset(first.nextOffset);
  assert.equal(second.events.length, 0);
  assert.equal(second.nextOffset, first.nextOffset);
});
