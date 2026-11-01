// `ready` needs readings that agree, and warm-up samples quickly. The first output timestamps after a context starts
// or resumes can be 10–90 ms off for a callback or three (the Studio's first Play in Chrome: −20, +8 and −90 ms,
// then exact). 0.3.0 and the first Unreleased mapper were ready on any three, so the median of those three put the
// first beat tens of ms off, and the background sampler took ~0.5 s to get there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioClockMapper } from '../src/audio-mapper.js';

const ORIGIN = 1_700_000_000_000;

/** A fake device. `bias` (s) is added to the next output timestamp's contextTime (a transient reading). */
function device() {
  const listeners = new Map<string, Set<() => void>>();
  let frozenAt = 0, lost = 0;
  const d = {
    perf: 1000,
    bias: 0,
    state: 'running',
    get currentTime() { return d.state === 'running' ? d.perf / 1000 + 5 - lost : frozenAt; },
    outputLatency: 0,
    baseLatency: 0,
    getOutputTimestamp: () => ({ contextTime: d.currentTime + d.bias, performanceTime: d.perf }) as { contextTime?: number; performanceTime?: number },
    addEventListener(type: string, l: () => void) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(l); },
    removeEventListener(type: string, l: () => void) { listeners.get(type)?.delete(l); },
    emit(type: string) { for (const l of listeners.get(type) ?? []) l(); },
    suspend() { frozenAt = d.currentTime; d.state = 'suspended'; d.emit('statechange'); },
    resume(afterMs: number) { d.perf += afterMs; lost += afterMs / 1000; d.state = 'running'; d.emit('statechange'); },
    get truth() { return d.currentTime - (ORIGIN + d.perf) / 1000; },
  };
  return d;
}
const errMs = (m: AudioClockMapper, d: ReturnType<typeof device>) => (m.offset - d.truth) * 1000;
const warmTimer = (m: AudioClockMapper) => (m as unknown as { warmTimer: unknown }).warmTimer;

test('settle: a resume transient (−20, +8, −90 ms readings) does not make it ready; three agreeing readings do, on their median', () => {
  const d = device();
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf, warmIntervalMs: 0 });
  m.start();
  for (let i = 0; i < 3; i++) { d.perf += 10; m.sampleIfNotReady(); }
  assert.equal(m.ready, true);
  d.suspend();
  d.bias = -0.020; d.resume(3000);              // the statechange's own sample reads the first transient
  assert.equal(m.ready, false);
  for (const bias of [0.008, -0.090]) { d.perf += 10; d.bias = bias; assert.equal(m.sampleIfNotReady(), false, `transient ${bias * 1000} ms`); }
  d.bias = 0;
  d.perf += 10; assert.equal(m.sampleIfNotReady(), false, 'one good reading');
  d.perf += 10; assert.equal(m.sampleIfNotReady(), false, 'two good readings');
  d.perf += 10; assert.equal(m.sampleIfNotReady(), true, 'three good readings agree: ready');
  assert.ok(Math.abs(errMs(m, d)) < 1e-3, `offset off by ${errMs(m, d)} ms (0.3.0: −20 ms, the transients' median)`);
  m.stop();
});

test('settle: started, it warms up on its own every 5 ms after a resume, and stops the fast sampling once ready', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const d = device();
  d.state = 'suspended';
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  m.start();
  assert.equal(warmTimer(m), null, 'no fast sampling while the context is suspended');
  d.bias = -0.031;
  d.resume(2000);
  const tick = (ms: number) => { for (let i = 0; i < ms; i++) { d.perf += 1; t.mock.timers.tick(1); } };
  tick(5); d.bias = 0;
  tick(20);
  assert.equal(m.ready, true, 'ready within ~20 ms of the resume (the 250 ms sampler alone: ~750 ms)');
  assert.ok(Math.abs(errMs(m, d)) < 1e-3, `offset off by ${errMs(m, d)} ms`);
  assert.equal(warmTimer(m), null, 'fast sampling stopped once ready');
  tick(1000);
  assert.ok(Math.abs(errMs(m, d)) < 1e-3);
  m.stop();
});

test('settle: a suspend stops warm-up; an output device change while running restarts it', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const d = device();
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  m.start();
  assert.notEqual(warmTimer(m), null, 'running and not ready: warming up');
  d.suspend();
  assert.equal(warmTimer(m), null, 'suspended: no fast sampling');
  d.resume(500);
  for (let i = 0; i < 30; i++) { d.perf += 1; t.mock.timers.tick(1); }
  assert.equal(m.ready, true);
  d.emit('sinkchange');
  assert.equal(m.ready, false);
  assert.notEqual(warmTimer(m), null, 'a device change re-measures quickly too');
  for (let i = 0; i < 30; i++) { d.perf += 1; t.mock.timers.tick(1); }
  assert.equal(m.ready, true);
  m.stop();
  assert.equal(warmTimer(m), null);
});

test('settle: no step detection before ready (warm-up readings are not steps)', () => {
  const d = device();
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  const steps: number[] = [];
  m.onStep(s => steps.push(s.stepSeconds));
  d.bias = -0.03; m.sample();
  d.bias = 0;
  for (let i = 0; i < 4; i++) { d.perf += 10; assert.equal(m.checkStep(), false); }
  assert.deepEqual(steps, []);
  for (let i = 0; i < 3; i++) { d.perf += 10; m.sample(); }
  assert.equal(m.ready, true);
  assert.equal(m.reanchors, 0);
  assert.ok(Math.abs(errMs(m, d)) < 1e-3);
});

test('settle: readings that never agree are ready on a full set (median of `samples`)', () => {
  const d = device();
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  const jitter = [0, 0.004, -0.004, 0.008, -0.008, 0.012, -0.012, 0.016];
  for (const j of jitter) { d.perf += 10; d.bias = j; m.sample(); }
  assert.equal(m.ready, false, 'eight readings, no three within 2 ms');
  d.perf += 10; d.bias = 0.0005; m.sample();
  assert.equal(m.ready, true, 'nine: ready anyway');
  assert.ok(Math.abs(errMs(m, d)) < 1, `median of the set (${errMs(m, d)} ms)`);
});

test('settle: without output timestamps, three currentTime − latency readings are ready, as before', () => {
  const d = device();
  const m = new AudioClockMapper({ get currentTime() { return d.currentTime + (d.perf % 3) / 1000; }, state: 'running', outputLatency: 0.01 }, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  for (let i = 0; i < 2; i++) { d.perf += 7; m.sample(); }
  assert.equal(m.ready, false);
  d.perf += 7; m.sample();
  assert.equal(m.ready, true, 'render-quantum jitter is not held against fallback readings');
});
