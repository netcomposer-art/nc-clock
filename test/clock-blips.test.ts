// Clock blips: a transient output-timestamp excursion that returns within `stepRevertMs` (default 200 ms) leaves
// no lasting re-anchor and puts the mapping back on the pre-step anchor exactly, while a real (persistent) device
// clock step is still confirmed in ~20 ms. The replay follows OLIVE Bass's hidden-tab run 3 (ASTRID-Bass
// docs/sync-results.md, nc-clock a9a9991): the leader's offset moved ~5 ms, came back in two parts over ~180 ms;
// 0.3.0 re-anchored on it (−5.1 ms) and back 150 ms later (+4.1 ms), and the beat between landed 4 ms late.
//
// Written against the public API only (options passed untyped), so the same file runs on 0.3.0 (b753634) as the
// negative control: there, the blip tests fail.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { AudioClockMapper, type ClockStep } from '../src/audio-mapper.js';

const ORIGIN = 1_700_000_000_000;

/**
 * A fake device. `shift` (s) is a real device clock step: contextTime moves against wall time, and the audio
 * moves with it. `blip(perfMs)` (s) moves only the reported output timestamp (the transient: what is heard
 * doesn't move). `noise` adds deterministic ±amp stamp jitter.
 */
function device(blip: (perfMs: number) => number = () => 0, amp = 0.0004) {
  let seed = 12345;
  const jitter = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed / 2147483648 * 2 - 1) * amp; };
  const d = {
    perf: 1000,
    shift: 0,
    get currentTime() { return d.perf / 1000 + 5 + d.shift; },
    state: 'running',
    outputLatency: 0,
    baseLatency: 0,
    getOutputTimestamp: () => ({ contextTime: d.currentTime + blip(d.perf) + jitter(), performanceTime: d.perf }),
    /** The offset the audio really has (what a beat is heard against). */
    get truth() { return d.currentTime - (ORIGIN + d.perf) / 1000; },
  };
  return d;
}

type Opts = Record<string, number>;
function setup(t: TestContext, blip?: (perfMs: number) => number, opts: Opts = {}) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const d = device(blip);
  // Untyped on purpose (see the header): `stepRevertMs` is not an option on 0.3.0.
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf, ...opts } as object);
  const steps: Array<ClockStep & { at: number }> = [];
  m.onStep(s => steps.push({ ...s, at: d.perf }));
  /** Error of a snapshot scheduler's beat rendered now (ms): the mapping against the audio. */
  const err = () => (m.offset - d.truth) * 1000;
  const errs: Array<[number, number]> = [];
  const tick = (ms: number) => { for (let i = 0; i < ms; i++) { d.perf += 1; t.mock.timers.tick(1); errs.push([d.perf, err()]); } };
  m.start();
  tick(3000); // 12 samples: a full 9-sample median
  return { d, m, steps, err, errs, tick };
}

/** OLIVE run 3, in mapper terms (s, from the excursion's start): −4.9 ms for 70 ms, −2.2 ms to 170 ms, then back. */
const oliveRun3 = (start: number) => (perf: number) => {
  const t = perf - start;
  return t < 0 || t >= 170 ? 0 : t < 70 ? -0.0049 : -0.0022;
};
/** A plain 5 ms excursion that reverts after `ms`. */
const plainBlip = (start: number, ms: number) => (perf: number) => (perf >= start && perf < start + ms ? -0.005 : 0);

const START = 1000 + 3000 + 20;

test('clock blips: a 5 ms excursion that reverts after 150 ms leaves no lasting re-anchor; error < 1 ms at its end', (t) => {
  const { m, steps, err, errs, tick } = setup(t, plainBlip(START, 150));
  tick(150);
  assert.ok(steps.length >= 1, 'the excursion is long enough to be confirmed (~20 ms): still applied at once');
  tick(100); // the excursion ended 100 ms ago: one check period plus the confirmation
  assert.ok(Math.abs(err()) < 1, `error ${err().toFixed(3)} ms at the blip's end`);
  tick(2000);
  m.stop();
  assert.equal(m.reanchors, 0, 'no lasting re-anchor');
  const after = Math.max(...errs.filter(([p]) => p >= START + 250).map(([, e]) => Math.abs(e)));
  assert.ok(after < 0.5, `after the blip the mapping is back on the pre-step anchor (max ${after.toFixed(3)} ms; stamp jitter ±0.4)`);
});

test('clock blips: replay of OLIVE run 3 (−4.9 ms, back in two parts over 170 ms): no lasting re-anchor, error < 1 ms at its end', (t) => {
  const { m, err, errs, tick } = setup(t, oliveRun3(START));
  tick(170 + 100);
  assert.ok(Math.abs(err()) < 1, `error ${err().toFixed(3)} ms 100 ms after the excursion ended`);
  tick(2000);
  m.stop();
  assert.equal(m.reanchors, 0, 'no lasting re-anchor');
  const worst = Math.max(...errs.filter(([p]) => p >= START + 270).map(([, e]) => Math.abs(e)));
  assert.ok(worst < 0.5, `back on the pre-step anchor after the blip (max ${worst.toFixed(3)} ms; stamp jitter ±0.4)`);
});

test('clock blips: replay of OLIVE run 3, hidden-tab-style timers (confirmations on 50 ms ticks): still no lasting re-anchor', (t) => {
  const { m, err, tick } = setup(t, oliveRun3(START), { stepConfirmMs: 50 });
  tick(170 + 200);
  assert.ok(Math.abs(err()) < 1, `error ${err().toFixed(3)} ms 200 ms after the excursion ended`);
  tick(2000);
  m.stop();
  assert.equal(m.reanchors, 0, 'no lasting re-anchor');
});

test('clock blips: a real 10 ms step is still confirmed in ~20 ms of being seen and stays (not taken for a blip)', (t) => {
  const { d, m, steps, err, tick } = setup(t);
  d.shift = -0.01;
  const at = d.perf;
  tick(100);
  assert.equal(steps.length, 1);
  assert.ok(steps[0].at - at <= 50 + 2 * 10 + 1, `confirmed ${steps[0].at - at} ms after the step`);
  assert.ok(Math.abs(steps[0].stepSeconds + 0.01) < 0.001);
  tick(2000);
  m.stop();
  assert.equal(steps.length, 1, 'no revert, no second re-anchor');
  assert.equal(m.reanchors, 1);
  assert.ok(Math.abs(err()) < 1, `error ${err().toFixed(3)} ms`);
});

test('clock blips: back-to-back real steps (−10 ms, then −10 ms 80 ms later) are both kept', (t) => {
  const { d, m, steps, err, tick } = setup(t);
  d.shift = -0.01; tick(80);
  d.shift = -0.02; tick(2000);
  m.stop();
  assert.equal(steps.length, 2);
  assert.ok(steps.every(s => !(s as { revert?: boolean }).revert));
  assert.equal(m.reanchors, 2);
  assert.ok(Math.abs(err()) < 1, `error ${err().toFixed(3)} ms`);
});

test('clock blips: a real step that comes back only after the window is two lasting re-anchors, not a revert', (t) => {
  const { d, m, steps, err, tick } = setup(t);
  d.shift = -0.01; tick(400);
  d.shift = 0; tick(2000);
  m.stop();
  assert.equal(steps.length, 2);
  assert.equal(m.reanchors, 2);
  assert.ok(Math.abs(err()) < 1, `error ${err().toFixed(3)} ms`);
});

test('clock blips: a blip followed by a real step: the blip reverts, the step is confirmed in ~20 ms and kept', (t) => {
  const { d, m, steps, err, tick } = setup(t, plainBlip(START, 120));
  tick(500);
  assert.equal(m.reanchors, 0, 'blip reverted');
  d.shift = -0.01;
  const at = d.perf, before = steps.length;
  tick(100);
  assert.equal(steps.length, before + 1);
  assert.ok(steps[before].at - at <= 50 + 2 * 10 + 1, `confirmed ${steps[before].at - at} ms after the step`);
  tick(2000);
  m.stop();
  assert.equal(m.reanchors, 1);
  assert.ok(Math.abs(err()) < 1, `error ${err().toFixed(3)} ms`);
});

test('clock blips: a revert fires onStep with revert: true and the exact way back; reverts counts it', (t) => {
  const { m, steps, tick } = setup(t, plainBlip(START, 150));
  tick(2500);
  m.stop();
  const last = steps[steps.length - 1] as ClockStep;
  assert.equal((last as { revert?: boolean }).revert, true);
  const sum = steps.reduce((a, s) => a + s.stepSeconds, 0);
  assert.ok(Math.abs(sum) < 1e-9, `the steps sum to zero (${sum * 1000} ms): queued events re-timed by each land back`);
  assert.equal((m as unknown as { reverts: number }).reverts, 1);
});

test('clock blips (negative control): with stepRevertMs 0 the replay re-anchors for good, the 0.3.0 behaviour', (t) => {
  const { m, tick } = setup(t, oliveRun3(START), { stepRevertMs: 0 });
  tick(2500);
  m.stop();
  assert.ok(m.reanchors >= 2, `re-anchors ${m.reanchors}: the excursion and its return each counted as a lasting step`);
});
