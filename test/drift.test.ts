// Audio clock drift with a long look-ahead: a click keeps the mapping of the moment it was queued, so with the
// audio clock ~83 ppm fast (as on a 2-core CI runner) a click queued 70 s ahead lands ~5.8 ms off the grid.
// examples/metronome/retime-drift.js moves queued clicks back onto the current mapping on every ticker tick.
// This test drives the real AudioClockMapper and the real retimeDrift() against a drifting fake device, and checks
// the timing guarantee (README, "Timing guarantee": p95 ≤ 1 ms, max ≤ 3 ms), and that without retimeDrift it fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioClockMapper } from '../src/audio-mapper.js';

type Click = { when: number; beat: number };
type RetimeDrift = (queued: Click[], target: (c: Click) => number, now: number) => { event: Click; when: number }[];
// The example is plain browser JS outside the TypeScript build; load it at run time (from .test-build/test/).
const { retimeDrift } = (await import(new URL('../../examples/metronome/retime-drift.js', import.meta.url).href)) as { retimeDrift: RetimeDrift };

const ORIGIN = 1_700_000_000_000;
const BEAT = 0.5;          // 120 BPM
const LOOKAHEAD = 70;      // s, the hidden-tab look-ahead that exposed the ramp
const TICK_MS = 25;        // Worker ticker period
const SAMPLE_MS = 1000;    // mapper sampling in a hidden tab (timers clamped to 1 s)
const QUANTUM = 128 / 48000;

/** A device whose audio clock runs `ppm` fast against performance.now(). */
function device(ppm: number) {
  const d = {
    perf: 1000,
    get currentTime() { return 5 + (d.perf / 1000) * (1 + ppm * 1e-6); },
    state: 'running',
    outputLatency: 0,
    baseLatency: 0,
    getOutputTimestamp: () => ({ contextTime: d.currentTime, performanceTime: d.perf }),
  };
  return d;
}

/** Plays `seconds` of a metronome that queues `LOOKAHEAD` ahead; returns |error| (ms) of every click heard. */
function play(ppm: number, fix: boolean, seconds = 150): number[] {
  const d = device(ppm);
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  const shared = () => (ORIGIN + d.perf) / 1000;
  // Shared time at which context time `when` is heard (the device's true mapping).
  const heardAt = (when: number) => (ORIGIN + ((when - 5) / (1 + ppm * 1e-6)) * 1000) / 1000;
  for (let i = 0; i < 9; i++) { d.perf += SAMPLE_MS; m.sample(); }
  const t0 = shared() + 0.5;
  const grid = (n: number) => t0 + n * BEAT;
  const queued: Click[] = [];
  const errors: number[] = [];
  let next = 0;
  for (let ms = 0; ms < seconds * 1000; ms += TICK_MS) {
    d.perf += TICK_MS;
    if (Math.round(d.perf) % SAMPLE_MS === 0) m.sample();
    const now = shared();
    while (grid(next) < now + LOOKAHEAD) { queued.push({ when: m.toContextTime(grid(next)), beat: next }); next++; }
    if (fix) for (const { event, when } of retimeDrift(queued, c => m.toContextTime(grid(c.beat)), d.currentTime)) queued.push({ ...event, when });
    // Render: clicks starting before the end of the next quantum are fixed now and heard at the device's true time.
    for (let i = queued.length - 1; i >= 0; i--) {
      const c = queued[i];
      if (c.when > d.currentTime + QUANTUM) continue;
      errors.push(Math.abs(heardAt(c.when) - grid(c.beat)) * 1000);
      queued.splice(i, 1);
    }
  }
  return errors;
}

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];
const max = (xs: number[]) => Math.max(...xs);

test('drift: 83 ppm with a 70 s look-ahead, retimeDrift keeps queued clicks inside p95 ≤ 1 ms, max ≤ 3 ms', () => {
  const errors = play(83, true);
  assert.ok(errors.length > 250, `heard ${errors.length} clicks`);
  assert.ok(p95(errors) <= 1, `p95 ${p95(errors).toFixed(3)} ms`);
  assert.ok(max(errors) <= 3, `max ${max(errors).toFixed(3)} ms`);
});

test('drift: without retimeDrift the same run breaks the guarantee (the CI hidden-tab ramp)', () => {
  const errors = play(83, false);
  assert.ok(max(errors) > 3, `max ${max(errors).toFixed(3)} ms`);
  assert.ok(p95(errors) > 1, `p95 ${p95(errors).toFixed(3)} ms`);
});

test('drift: no drift, no moves; the look-ahead alone is exact', () => {
  const errors = play(0, true, 60);
  assert.ok(max(errors) < 0.01, `max ${max(errors).toFixed(4)} ms`);
});
