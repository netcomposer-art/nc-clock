// Hold (the `hold` option): one mapper shared by several schedulers on one context keeps one fixed mapping while the
// transport runs. From the NetComposer Studio: an underrun left the context clock ~40 ms behind wall time, the
// shared mapper re-anchored, and Rhythm had rendered a beat on the old mapping while Bass rendered it on the new
// one (1,787 samples apart at 44.1 kHz in studio.e2e; 1,934 in first-play.e2e).
import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioClockMapper, type ClockStep } from '../src/audio-mapper.js';

const ORIGIN = 1_700_000_000_000;
const BEAT = 0.5;

/** A fake device: contextTime runs with wall time, minus `lag` seconds lost to underruns. */
function device() {
  const d = {
    perf: 1000, // performance.now(), ms
    lag: 0,
    get currentTime() { return d.perf / 1000 + 5 - d.lag; },
    state: 'running',
    outputLatency: 0,
    baseLatency: 0,
    getOutputTimestamp: () => ({ contextTime: d.currentTime, performanceTime: d.perf }),
  };
  return d;
}

/** Drive the mapper as start() would: a step check every 10 ms, a median sample every 250 ms. */
function run(d: ReturnType<typeof device>, m: AudioClockMapper, ms: number) {
  for (let t = 0; t < ms; t += 10) {
    d.perf += 10;
    m.checkStep();
    if (Math.round(d.perf) % 250 === 0) m.sample();
  }
}

/**
 * Two schedulers on one context map the same beat: A while a 150 ms main-thread stall is about to hide an underrun
 * (it maps before the step is confirmed), B after the mapper has confirmed it. Returns B − A in ms.
 */
function twoSchedulers(hold: boolean) {
  const d = device();
  let running = false;
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf, ...(hold ? { hold: () => running } : {}) });
  const steps: ClockStep[] = [];
  m.onStep(s => steps.push(s));
  run(d, m, 1000);
  assert.ok(m.ready);
  running = true; // the transport starts
  const start = m.sharedNow() + 0.5;
  run(d, m, 2000);
  const beat = start + 8 * BEAT; // ~1 s ahead: A maps it now
  const a = m.toContextTime(beat);
  // An underrun: the context clock falls 40 ms behind wall time while the main thread stalls for 150 ms.
  d.lag += 0.04; d.perf += 150;
  run(d, m, 300); // the mapper confirms the step (~30 ms after the stall)
  const b = m.toContextTime(beat);
  return { d, m, steps, deltaMs: (b - a) * 1000, stop: () => { running = false; } };
}

test('hold: without it, a step between two schedulers\' reads puts one beat ~40 ms apart (the Studio bug)', () => {
  const { m, steps, deltaMs } = twoSchedulers(false);
  assert.equal(m.reanchors, 1);
  assert.equal(steps.length, 1);
  assert.ok(Math.abs(deltaMs + 40) < 0.01, `B − A = ${deltaMs} ms`);
});

test('hold: while held, every read maps a beat to the same context time across an underrun and a stall', () => {
  const { d, m, steps, deltaMs, stop } = twoSchedulers(true);
  assert.equal(deltaMs, 0, `B − A = ${deltaMs} ms`);
  assert.equal(m.holding, true);
  assert.equal(m.reanchors, 1, 'the estimate still follows the device step');
  assert.equal(steps.length, 0, 'onStep is quiet: the mapping in force did not move');
  // More underruns and periodic samples over a long run: the mapping stays exactly where it was.
  const held = m.offset;
  for (let i = 0; i < 5; i++) { d.lag += 0.02; run(d, m, 3000); }
  assert.equal(m.offset, held);
  assert.equal(m.settledNow(), true, 'settledNow judges the estimate, not the held mapping');
  // The transport stops: the offset is the estimate again (all 140 ms of underruns at once, nothing playing).
  stop();
  assert.ok(Math.abs((m.offset - held) * 1000 + 140) < 0.01, `moved ${(m.offset - held) * 1000} ms`);
  assert.equal(m.holding, false);
  assert.equal(steps.length, 0);
});

test('hold: the held value is the estimate from before the sample or step that follows the start', () => {
  const d = device();
  let running = false;
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf, hold: () => running });
  run(d, m, 1000);
  const before = m.offset;
  running = true;
  d.lag += 0.03; // the step lands before anyone reads the offset
  run(d, m, 600);
  assert.equal(m.reanchors, 1);
  assert.equal(m.offset, before, 'held at the estimate the start was committed on');
});

test('hold: not before ready, and an invalid anchor (sinkchange) drops the held value', () => {
  const d = device();
  const listeners: Record<string, () => void> = {};
  const ctx = Object.assign(d, { addEventListener: (t: string, l: () => void) => { listeners[t] = l; }, removeEventListener: () => {} });
  const m = new AudioClockMapper(ctx, { timeOrigin: ORIGIN, perfNow: () => d.perf, hold: () => true, warmIntervalMs: 0 });
  assert.equal(m.holding, false, 'nothing to hold before the first samples');
  m.start();
  m.stop();
  for (let i = 0; i < 3; i++) { d.perf += 10; m.sample(); }
  assert.equal(m.ready, true);
  const first = m.offset;
  assert.equal(m.holding, true);
  d.lag += 0.05; run(d, m, 600);
  assert.equal(m.offset, first);
  listeners.sinkchange?.(); // a new output device: re-measure
  for (let i = 0; i < 3; i++) { d.perf += 10; m.sample(); }
  assert.ok(Math.abs((m.offset - first) * 1000 + 50) < 0.01, 'held again on the new anchor');
  d.lag += 0.01; run(d, m, 600);
  assert.ok(Math.abs((m.offset - first) * 1000 + 50) < 0.01);
});
