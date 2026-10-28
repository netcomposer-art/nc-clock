// NcClock.subscribe: a replaying subscription (the current state at once, then every change), for a scheduler
// attached late on a steady clock. onChange keeps its change-only semantics. Pattern: Rhythm/Bass SnapshotFeed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NcClock, type ClockChange } from '../src/core/index.js';

test('subscribe: replays the current state at once on a steady (playing) clock, then delivers changes', () => {
  const clock = new NcClock({ bpm: 120, timebase: 'shared' });
  clock.play({ at: 100 });
  const late: ClockChange[] = [], changes: ClockChange[] = [];
  clock.onChange(c => changes.push(c));
  const off = clock.subscribe(c => late.push(c));
  assert.equal(late.length, 1, 'replayed at once');
  assert.equal(changes.length, 0, 'onChange heard nothing: no change happened');
  const r = late[0];
  assert.ok(r.kind === 'snapshot' && r.replay === true);
  if (r.kind === 'snapshot') {
    assert.deepEqual(r.snapshot, clock.toSnapshot());
    assert.equal(r.snapshot.playing, true);
    assert.equal(r.snapshot.startTime, 100);
  }
  clock.commitTempo(90, 8);
  assert.equal(late.length, 2); assert.equal(changes.length, 1);
  assert.deepEqual(late[1], changes[0], 'later changes are exactly what onChange hears');
  off();
  clock.commitStop(200);
  assert.equal(late.length, 2, 'unsubscribed');
});

test('subscribe: a stopped clock replays too, and a replayed snapshot rebuilds the same timeline', () => {
  const clock = new NcClock({ bpm: 96 });
  let got: ClockChange | null = null;
  clock.subscribe(c => { got = c; });
  assert.ok(got);
  const g = got as ClockChange;
  assert.ok(g.kind === 'snapshot' && g.replay && g.snapshot.playing === false);
  const follower = new NcClock();
  if (g.kind === 'snapshot') follower.applySnapshot(g.snapshot);
  assert.equal(follower.transport.timeAt(16), clock.transport.timeAt(16));
});

test('subscribe: unsubscribing leaves no listener behind; real snapshots carry no replay flag', () => {
  const clock = new NcClock();
  let calls = 0;
  const off = clock.subscribe(() => { calls++; });
  off();
  clock.commitStart(1);
  assert.equal(calls, 1);
  const seen: ClockChange[] = [];
  clock.onChange(c => seen.push(c));
  clock.applySnapshot(clock.toSnapshot());
  assert.ok(seen[0].kind === 'snapshot' && seen[0].replay === undefined);
});
