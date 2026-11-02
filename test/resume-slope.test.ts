// After an AudioContext suspend and resume (an app's idle suspend: the context clock stands still while wall time
// runs on), the mapper re-anchors: its mapping error has |slope| <= 0.5 ms/s over 0-5 s after the resume, also when
// the resumed output stream then settles (its output timestamp sliding against performance.now(), as Chrome's does
// under load, then flat). The control shows the gate catches a stale anchor: a mapper that never hears the
// statechange rolls its median from the pre-suspend anchor to the new one inside the window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioClockMapper } from '../src/audio-mapper.js';

const ORIGIN = 1_700_000_000_000;
const GATE = 0.5; // ms/s

/** Least-squares slope (ms/s) of ys (ms) against xs (s). */
function slope(xs: number[], ys: number[]): number {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  return sxy / sxx;
}

/**
 * Suspends for 500 ms after 3 s of play, resumes, and returns the slope (ms/s) of the mapping error (mapper offset
 * minus the device's true one) over 0-5 s after the resume. `settleMsPerS`: the stream's timestamp slides by this
 * for 4 s after the resume (a ramp), then holds. `listen`: false starts a mapper with no statechange events.
 */
function afterResume(t: import('node:test').TestContext, settleMsPerS: number, listen = true) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const listeners = new Set<() => void>();
  let perf = 1000, lost = 0, frozen = 0, resumedAt = -1;
  const settle = () => resumedAt < 0 ? 0 : Math.min(perf - resumedAt, 4000) / 1000 * settleMsPerS / 1000;
  const d = {
    state: 'running',
    get currentTime() { return d.state === 'running' ? perf / 1000 + 5 - lost : frozen; },
    outputLatency: 0.032,
    getOutputTimestamp: () => ({ contextTime: d.currentTime + settle(), performanceTime: perf }),
    addEventListener(type: string, l: () => void) { if (listen && type === 'statechange') listeners.add(l); },
    removeEventListener(_: string, l: () => void) { listeners.delete(l); },
  };
  const truth = () => d.currentTime + settle() - (ORIGIN + perf) / 1000;
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => perf });
  const advance = (ms: number) => { for (let i = 0; i < ms; i++) { perf++; t.mock.timers.tick(1); } };
  m.start();
  advance(3000);
  assert.equal(m.ready, true);
  frozen = d.currentTime; d.state = 'suspended'; for (const l of listeners) l();
  perf += 500; lost += 0.5;
  d.state = 'running'; resumedAt = perf; for (const l of listeners) l();
  const xs: number[] = [], ys: number[] = [];
  for (let k = 0; k < 250; k++) {
    advance(20);
    if (!m.sampleIfNotReady()) continue; // as an app's first Play does before scheduling
    xs.push((perf - resumedAt) / 1000); ys.push((m.offset - truth()) * 1000);
  }
  m.stop();
  t.diagnostic(`slope ${slope(xs, ys).toFixed(3)} ms/s, max error ${Math.max(...ys.map(Math.abs)).toFixed(3)} ms, ${xs.length} readings`);
  return { slope: slope(xs, ys), n: xs.length, maxErr: Math.max(...ys.map(Math.abs)) };
}

test('resume: the mapper re-anchors; mapping error |slope| <= 0.5 ms/s over 0-5 s after the resume', (t) => {
  const r = afterResume(t, 0);
  assert.ok(r.n > 200, `readings ${r.n}`);
  assert.ok(Math.abs(r.slope) <= GATE, `slope ${r.slope.toFixed(3)} ms/s`);
  assert.ok(r.maxErr < 0.01, `max error ${r.maxErr} ms`);
});

for (const settle of [-3, -1, 1]) {
  test(`resume: a stream that settles at ${settle} ms/s for 4 s after the resume is followed within the gate`, (t) => {
    const r = afterResume(t, settle);
    assert.ok(Math.abs(r.slope) <= GATE, `slope ${r.slope.toFixed(3)} ms/s`);
    assert.ok(r.maxErr <= Math.abs(settle) * 1.5 + 0.01, `max error ${r.maxErr.toFixed(3)} ms`);
  });
}

test('resume control: without the statechange re-anchor the stale anchor fails the gate', (t) => {
  const r = afterResume(t, 0, false);
  assert.ok(Math.abs(r.slope) > GATE, `slope ${r.slope.toFixed(3)} ms/s`);
});
