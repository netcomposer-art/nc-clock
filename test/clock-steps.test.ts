// Device clock steps: AudioClockMapper re-anchors on a confirmed ~10 ms step, ignores one-off spikes and
// zero (glitch) timestamps, and events computed before the step land on the grid once re-timed.
// Approach and the zero-timestamp guarantee follow OLIVE Bass `clock-link` (Olive, ASTRID-Bass PR #1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioClockMapper, retimeForStep, type ClockStep } from '../src/audio-mapper.js';

const ORIGIN = 1_700_000_000_000;
const BPM = 120;
const BEAT = 60 / BPM;

/** A fake device: contextTime runs with wall time, plus `shift` seconds of accumulated clock steps. */
function device() {
  const d = {
    perf: 1000, // performance.now(), ms
    shift: 0,
    glitch: false,
    frozen: 0,
    get currentTime() { return d.perf / 1000 + 5 + d.shift; },
    state: 'running',
    outputLatency: 0,
    baseLatency: 0,
    getOutputTimestamp: () => d.glitch ? { contextTime: d.frozen, performanceTime: 0 } : { contextTime: d.currentTime, performanceTime: d.perf },
  };
  return d;
}

/** Drive the mapper as start() would: a step check every 50 ms, a median sample every 250 ms. */
function run(d: ReturnType<typeof device>, m: AudioClockMapper, ms: number) {
  for (let t = 0; t < ms; t += 50) {
    d.perf += 50;
    m.checkStep();
    if (Math.round(d.perf) % 250 === 0) m.sample();
  }
}

/** Shared time (s) of beat `n`, with beat 0 at shared time `t0`. */
const beatAt = (t0: number, n: number) => t0 + n * BEAT;

test('clock steps: a confirmed 10 ms step re-anchors within ~150 ms, not on one-off jitter', () => {
  const d = device();
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  const steps: ClockStep[] = [];
  m.onStep(s => steps.push(s));
  run(d, m, 2500);
  const before = m.offset;
  d.shift = 0.0105; d.perf += 50; m.checkStep(); // a single jittery reading
  d.shift = 0; run(d, m, 500);
  assert.equal(m.reanchors, 0, 'one-off spike ignored');
  d.shift = 0.01;
  run(d, m, 100);
  assert.equal(m.reanchors, 0, 'two readings are not enough');
  run(d, m, 50);
  assert.equal(m.reanchors, 1, 'third agreeing reading confirms');
  assert.ok(Math.abs((m.offset - before) * 1000 - 10) < 1e-3, `offset moved ${(m.offset - before) * 1000} ms`);
  assert.equal(steps.length, 1);
  assert.ok(Math.abs(steps[0].stepSeconds - 0.01) < 1e-6);
  run(d, m, 2000);
  assert.equal(m.reanchors, 1, 'no repeat re-anchor');
  const off = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf, stepThresholdMs: 0 });
  off.sample(); d.shift = 0.02; run(d, off, 500);
  assert.equal(off.reanchors, 0, 'stepThresholdMs 0 turns detection off');
});

test('clock steps: zero output timestamps (performanceTime 0, frozen position) never re-anchor', () => {
  const d = device();
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  run(d, m, 1000);
  const before = m.offset;
  d.frozen = d.currentTime; d.glitch = true;
  // Unguarded, a frozen reading would look like a constant step of about timeOrigin, confirmed every check.
  for (let i = 0; i < 30; i++) { d.perf += 50; assert.equal(m.checkStep(), false); }
  assert.equal(m.reanchors, 0);
  assert.ok(Math.abs(m.offset - before) < 0.001);
  d.glitch = false; run(d, m, 750);
  assert.equal(m.reanchors, 0);
});

test('clock steps: events scheduled before a 10 ms step land on the grid after re-timing; ones already rendered are off by exactly the step', () => {
  const d = device();
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  run(d, m, 2000);
  const oldOffset = m.offset;
  const t0 = Math.ceil(m.sharedNow()) + 1;
  // A scheduler queues 8 beats ahead (4 s) in context time with today's offset.
  let queue = Array.from({ length: 8 }, (_, n) => m.toContextTime(beatAt(t0, n)));
  let rerendered: number[] = [];
  m.onStep(step => {
    rerendered = queue.filter(when => when <= d.currentTime);
    queue = queue.map(when => retimeForStep(when, step, d.currentTime + 128 / 48000));
  });
  // Advance to 10 ms before beat 2 is heard, then the device drops a 10 ms buffer.
  d.perf = (beatAt(t0, 2) * 1000 - ORIGIN) - 10;
  d.shift = 0.01;
  // Detection window (3 checks × 50 ms): beat 2 is rendered with the old offset meanwhile.
  run(d, m, 150);
  assert.equal(m.reanchors, 1);
  // Where each event is heard on the shared timeline: beats 0–1 sounded before the step (old device
  // clock); everything from beat 2 on sounds after it (new device clock).
  const errMs = queue.map((when, n) => ((when - (n < 2 ? oldOffset : m.offset)) - beatAt(t0, n)) * 1000);
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-3; // 1 µs: epoch-seconds float resolution
  for (const n of [0, 1]) assert.ok(near(errMs[n], 0), `beat ${n} off by ${errMs[n]} ms`);
  // Beat 2 was rendered inside the detection window with the old offset: a one-off error of exactly the step.
  assert.ok(near(errMs[2], -10), `beat 2 off by ${errMs[2]} ms`);
  // Beats 3–7 were queued before the step and re-timed on confirmation: back on the grid.
  for (let n = 3; n < 8; n++) assert.ok(near(errMs[n], 0), `beat ${n} off by ${errMs[n]} ms`);
  assert.equal(rerendered.length, 3, 'beats 0–2 were already rendered when the step was confirmed');
  // Snapshot schedulers (no queue, the worklet maps every block): new times are exact at once.
  assert.ok(near((m.toContextTime(beatAt(t0, 9)) - m.offset - beatAt(t0, 9)) * 1000, 0));
});

test('first reading: placeholder output timestamps right after start are not used; ready waits for a real one', () => {
  // Chrome, the first output callbacks after the context starts (probed in headless Chrome): contextTime stays
  // ~0.00002–0.00005 s while performanceTime runs on, so these read ~20 then ~10 ms late. Seen in ASTRID two-tab
  // runs as a +20 ms (or +10 ms) first note on join.
  const d = device();
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  const truth = () => d.currentTime - (ORIGIN + d.perf) / 1000;
  d.getOutputTimestamp = () => ({ contextTime: 0.00002, performanceTime: d.perf });
  assert.equal(m.ready, false, 'placeholder: not ready');
  d.perf += 10; d.getOutputTimestamp = () => ({ contextTime: 0.00005, performanceTime: d.perf });
  assert.equal(m.ready, false, 'a moving placeholder: still not ready');
  d.perf += 10; d.getOutputTimestamp = () => ({ contextTime: d.currentTime, performanceTime: d.perf });
  assert.equal(m.ready, false, 'one real stamp: not yet (median of three)');
  assert.equal(m.ready, false, 'the same stamp again adds nothing');
  d.perf += 10; d.getOutputTimestamp = () => ({ contextTime: d.currentTime + 0.002, performanceTime: d.perf }); // a 2 ms jittery one
  assert.equal(m.ready, false);
  d.perf += 10; d.getOutputTimestamp = () => ({ contextTime: d.currentTime, performanceTime: d.perf });
  assert.equal(m.ready, true, 'three real stamps: ready');
  assert.ok(Math.abs((m.offset - truth()) * 1000) < 1e-3, `offset off by ${(m.offset - truth()) * 1000} ms`);
});

test('first reading: a timestamp that never gets real falls back to currentTime − latency after 500 ms', () => {
  const d = device();
  d.getOutputTimestamp = () => ({ contextTime: 0, performanceTime: 0 });
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  assert.equal(m.ready, false);
  d.perf += 400; assert.equal(m.ready, false);
  d.perf += 200; m.sample(); m.sample(); assert.equal(m.ready, true);
  assert.ok(Math.abs(m.offset - (d.currentTime - (ORIGIN + d.perf) / 1000)) < 1e-9);
});
