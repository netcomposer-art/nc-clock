// One output timestamp is one sample: start() and the first sampleIfNotReady() in the same task read the same
// stamp, and it must not count twice towards `ready` (0.3.0 counted it twice: ready after two real readings).
import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioClockMapper } from '../src/audio-mapper.js';

const ORIGIN = 1_700_000_000_000;

function device() {
  const d = {
    perf: 1000,
    state: 'running',
    get currentTime() { return d.perf / 1000 + 5; },
    outputLatency: 0,
    baseLatency: 0,
    getOutputTimestamp: () => ({ contextTime: d.currentTime, performanceTime: d.perf }),
  };
  return d;
}

test('first sample: start() then sampleIfNotReady() on the same stamp is one reading; ready needs three distinct stamps', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const d = device();
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  m.start();                                           // samples stamp A
  assert.equal(m.sampleIfNotReady(), false);           // stamp A again: nothing new
  d.perf += 3;
  assert.equal(m.sampleIfNotReady(), false, 'two distinct stamps: not ready yet (0.3.0 said ready here)');
  d.perf += 3;
  assert.equal(m.sampleIfNotReady(), true, 'third distinct stamp: ready');
  m.stop();
});

test('first sample: sample() itself dedupes an identical stamp (returns true, adds nothing)', () => {
  const d = device();
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  assert.equal(m.sample(), true);
  assert.equal(m.sample(), true);
  assert.equal(m.sample(), true);
  assert.equal(m.ready, false, 'three reads of one stamp are one sample');
  d.perf += 3; m.sample(); d.perf += 3; m.sample();
  assert.equal(m.ready, true);
});
