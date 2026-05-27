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

test('active run event stream appends and replays commands', () => {
  const repoRoot = mkRepoLocalTempDir('active-run-stream-cmd-');
  const stream = new ActiveRunEventStream(repoRoot, 'run-1');

  stream.appendProgress({ ticketLabel: 'feature/01', kind: 'message', message: 'started' });
  stream.appendCommand('kill');
  stream.appendProgress({ ticketLabel: 'feature/01', kind: 'message', message: 'done' });

  const events = stream.readFromOffset(0);
  assert.equal(events.events.length, 2);

  const commands = stream.readCommandsFromOffset(0);
  assert.equal(commands.commands.length, 1);
  assert.equal(commands.commands[0], 'kill');

  const noMoreCommands = stream.readCommandsFromOffset(commands.nextOffset);
  assert.equal(noMoreCommands.commands.length, 0);
});

test('readAllEvents returns all progress events', () => {
  const repoRoot = mkRepoLocalTempDir('active-run-stream-all-');
  const stream = new ActiveRunEventStream(repoRoot, 'run-1');

  stream.appendProgress({ ticketLabel: 'feature/01', kind: 'message', message: 'started' });
  stream.appendCommand('kill');
  stream.appendProgress({ ticketLabel: 'feature/01', kind: 'message', message: 'done' });
  stream.appendRunState('running');

  const all = stream.readAllEvents();
  assert.equal(all.length, 2);
  assert.equal(all[0]?.message, 'started');
  assert.equal(all[1]?.message, 'done');
});

test('readAllEvents returns empty array when no file exists', () => {
  const repoRoot = mkRepoLocalTempDir('active-run-stream-empty-');
  const stream = new ActiveRunEventStream(repoRoot, 'run-missing');
  assert.deepEqual(stream.readAllEvents(), []);
});
