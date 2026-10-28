// `ready` across re-anchors and suspend/resume: it stays true inside onStep and across a statechange where the
// context clock kept pace; it resets (three new real samples) when the anchor is invalid: a real suspend (the
// context clock stood still) or an output device change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioClockMapper } from '../src/audio-mapper.js';

const ORIGIN = 1_700_000_000_000;

/** A fake device with events. `paused` freezes contextTime (a suspended context); `shift` is a clock step. */
function device() {
  const listeners = new Map<string, Set<() => void>>();
  let frozenAt = 0, lost = 0;
  const d = {
    perf: 1000,
    shift: 0,
    state: 'running',
    get currentTime() { return d.state === 'running' ? d.perf / 1000 + 5 + d.shift - lost : frozenAt; },
    outputLatency: 0,
    baseLatency: 0,
    getOutputTimestamp: () => ({ contextTime: d.currentTime, performanceTime: d.perf }),
    addEventListener(type: string, l: () => void) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(l); },
    removeEventListener(type: string, l: () => void) { listeners.get(type)?.delete(l); },
    emit(type: string) { for (const l of listeners.get(type) ?? []) l(); },
    /** Suspend for `ms` (the context clock stands still, wall time runs) and resume. */
    suspendFor(ms: number, freeze = true) {
      frozenAt = d.currentTime; d.state = 'suspended'; d.emit('statechange');
      d.perf += ms;
      if (freeze) lost += ms / 1000;
      d.state = 'running'; d.emit('statechange');
    },
    get truth() { return d.currentTime - (ORIGIN + d.perf) / 1000; },
  };
  return d;
}

function run(d: ReturnType<typeof device>, m: AudioClockMapper, ms: number) {
  for (let t = 0; t < ms; t += 50) { d.perf += 50; m.checkStep(); if (Math.round(d.perf) % 250 === 0) m.sample(); }
}

test('ready: stays true inside onStep and after a confirmed step; the offset is the stepped one', () => {
  const d = device();
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  run(d, m, 2500);
  assert.equal(m.ready, true);
  const seen: boolean[] = [];
  m.onStep(() => seen.push(m.ready));
  d.shift = 0.01;
  run(d, m, 200);
  assert.deepEqual(seen, [true], 'ready read inside onStep');
  assert.equal(m.ready, true);
  assert.ok(Math.abs((m.offset - d.truth) * 1000) < 1e-3, `offset off by ${(m.offset - d.truth) * 1000} ms`);
  run(d, m, 3000);
  assert.ok(Math.abs((m.offset - d.truth) * 1000) < 1e-3, 'new samples agree with the stepped anchor');
});

test('ready: a real suspend (context clock stands still) resets it on resume; three new real samples bring it back', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const d = device();
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  m.start();
  for (let i = 0; i < 1000; i++) { d.perf++; t.mock.timers.tick(1); }
  assert.equal(m.ready, true);
  d.suspendFor(2000);
  assert.equal(m.ready, false, 'anchor invalid: the context lost 2 s against wall time');
  d.perf += 3; assert.equal(m.sampleIfNotReady(), false, 'the resume sample plus one more: not yet');
  d.perf += 3; assert.equal(m.sampleIfNotReady(), true);
  m.stop();
  assert.ok(Math.abs((m.offset - d.truth) * 1000) < 1e-3, 'new anchor is right');
});

test('ready: a statechange where the context clock kept pace keeps it (and the anchor)', () => {
  const d = device();
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  m.start();
  run(d, m, 1000);
  const before = m.offset;
  d.suspendFor(40, false); // e.g. a brief 'interrupted' that didn't stop the clock
  assert.equal(m.ready, true);
  assert.equal(m.offset, before);
  d.emit('statechange'); // a repeated 'running' event
  assert.equal(m.ready, true);
  m.stop();
});

test('ready: an output device change (sinkchange) always re-measures', () => {
  const d = device();
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  m.start();
  run(d, m, 1000);
  d.emit('sinkchange');
  assert.equal(m.ready, false);
  m.stop();
});

test('ready: started on a suspended context, the first resume re-measures', () => {
  const d = device();
  d.state = 'suspended';
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  m.start();
  assert.equal(m.ready, false);
  d.perf += 500; d.state = 'running'; d.emit('statechange');
  for (let i = 0; i < 3; i++) { d.perf += 3; m.sampleIfNotReady(); }
  assert.equal(m.ready, true);
  m.stop();
});

test('stop(): resets the revert window and the pause record', () => {
  const d = device();
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  const internal = m as unknown as { revertUntil: number; pausedCtx: number | null; pausedWall: number };
  run(d, m, 2500);
  d.shift = 0.01;
  run(d, m, 150);                                  // confirmed: a revert window opens (200 ms of audio clock time)
  assert.equal(m.reanchors, 1);
  assert.ok(Number.isFinite(internal.revertUntil), 'window open');
  m.stop();
  assert.equal(internal.revertUntil, -Infinity, 'stop() closes the revert window');
  d.shift = 0;                                     // back at the old anchor, still inside the old window's time
  run(d, m, 150);
  assert.equal(m.reverts, 0, 'not a revert of a window from before stop()');
  assert.equal(m.reanchors, 2, 'a new step');
  // The pause record: suspended (recorded) and then stopped.
  m.start();
  d.state = 'suspended'; d.emit('statechange');
  assert.notEqual(internal.pausedCtx, null);
  m.stop();
  assert.equal(internal.pausedCtx, null, 'stop() drops the pause record');
  assert.equal(internal.pausedWall, 0);
  d.state = 'running';
});
