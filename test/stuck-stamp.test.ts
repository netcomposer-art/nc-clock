// A real output stamp that never changes while the context runs (a stuck timestamp) must not leave the mapper
// unready forever: after STAMP_WAIT_MS (500 ms) on one unchanged stamp it falls back to currentTime − latency, as for
// placeholder stamps. 0.3.0 got ready in three ticks (it counted the one stamp three times); d07b8dd's dedupe alone
// never did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioClockMapper } from '../src/audio-mapper.js';

const ORIGIN = 1_700_000_000_000;

function stuckDevice() {
  const d = {
    perf: 1000,
    state: 'running',
    get currentTime() { return d.perf / 1000 + 5; },
    outputLatency: 0.02,
    baseLatency: 0,
    // One real stamp, frozen: contextTime ≥ 3 ms and performanceTime > 0, but never updated.
    getOutputTimestamp: () => ({ contextTime: 6, performanceTime: 1000 }),
  };
  return d;
}

test('stuck stamp: one unchanged real stamp while running falls back after STAMP_WAIT_MS and gets ready', () => {
  const d = stuckDevice();
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  let readyAt: number | null = null;
  for (let tick = 0; tick <= 40 && readyAt === null; tick++) { // 10 s of 250 ms ticks
    m.sample();
    if (m.ready) readyAt = d.perf - 1000;
    else d.perf += 250;
  }
  assert.notEqual(readyAt, null, 'never ready on a stuck stamp');
  assert.ok(readyAt! >= 500 && readyAt! <= 1000, `ready after ${readyAt} ms (wait 500 ms, then fallback samples)`);
  // The fallback is currentTime − latency − shared now; here currentTime − shared = 5 − ORIGIN/1000 exactly.
  const expect = 5 - 0.02 - ORIGIN / 1000;
  assert.ok(Math.abs(m.offset - expect) < 0.021, `offset ${m.offset} vs fallback ${expect} (median includes the stamp)`);
});

test('stuck stamp: a stamp repeated within STAMP_WAIT_MS is still one reading (dedupe kept)', () => {
  const d = stuckDevice();
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  for (let i = 0; i < 4; i++) { assert.equal(m.sample(), true); d.perf += 100; } // 0–300 ms on one stamp
  assert.equal(m.ready, false);
});

test('stuck stamp: once ready, a stamp that freezes keeps the anchor (no fallback mixed in)', () => {
  const d = { perf: 1000, frozen: false, state: 'running', get currentTime() { return d.perf / 1000 + 5; },
    outputLatency: 0.02, baseLatency: 0,
    getOutputTimestamp: () => d.frozen ? { contextTime: 6.009, performanceTime: 1009 } : { contextTime: d.currentTime, performanceTime: d.perf } };
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf });
  for (let i = 0; i < 3; i++) { m.sample(); d.perf += 3; }
  assert.equal(m.ready, true);
  const before = m.offset;
  d.frozen = true;
  for (let i = 0; i < 12; i++) { m.sample(); d.perf += 250; }
  assert.equal(m.offset, before, 'anchor unchanged while the stamp is stuck');
});
