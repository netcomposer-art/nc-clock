import test from 'node:test';
import assert from 'node:assert/strict';
import { TempoMap, Transport, NcClock, toSnapshot, fromSnapshot, shiftSnapshot, validateSnapshot, nextGridBeat, SNAPSHOT_VERSION } from '../src/core/index.js';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('tempo map: beat ↔ time at one tempo, both directions', () => {
  const m = new TempoMap({ bpm: 120, anchor: { beat: 0, time: 10 } });
  near(m.timeAt(0), 10); near(m.timeAt(4), 12); near(m.beatAt(11), 2);
  near(m.timeAt(-2), 9); near(m.beatAt(9), -2);
});

test('tempo map: a change lands exactly on the requested beat', () => {
  const m = new TempoMap({ bpm: 120, anchor: { beat: 0, time: 0 } });
  m.setTempoAt(60, 8);
  near(m.timeAt(8), 4); near(m.timeAt(9), 5); near(m.beatAt(4.5), 8.5);
  assert.equal(m.bpmAt(7.999), 120); assert.equal(m.bpmAt(8), 60);
  m.setTempoAt(180, 6); // replaces the later point
  assert.deepEqual(m.points, [{ beat: 0, bpm: 120 }, { beat: 6, bpm: 180 }]);
  near(m.timeAt(9), 3 + 3 * 60 / 180);
});

test('tempo map: round trips over many random points', () => {
  const m = new TempoMap({ bpm: 97, anchor: { beat: 3, time: 1234.5 } });
  let beat = 3;
  for (let i = 0; i < 200; i++) { beat += 0.5 + (i * 7919 % 13) / 4; m.setTempoAt(40 + (i * 104729 % 200), beat); }
  for (let b = -4; b < beat + 10; b += 0.37) near(m.beatAt(m.timeAt(b)), b, 1e-6);
});

test('tempo map: clamps to its range and ramps as steps', () => {
  const m = new TempoMap({ bpm: 120, minBpm: 20, maxBpm: 240 });
  m.setTempoAt(999, 4); assert.equal(m.bpmAt(4), 240);
  m.rampTempo(80, 8, 4, 1);
  assert.equal(m.bpmAt(7.9), 240); assert.equal(m.bpmAt(11), 80);
  assert.ok(m.bpmAt(9) < 240 && m.bpmAt(9) > 80);
});

test('no drift over 20,000 steps: every step time comes from the anchor', () => {
  const t = new Transport({ bpm: 133 });
  t.start({ at: 1e9 + 0.123, beat: 0 }); // shared-epoch scale numbers
  let sum = 1e9 + 0.123, worstSum = 0, worstClock = 0;
  const step = 60 / 133 / 4;
  for (let k = 0; k < 20000; k++) {
    const exact = 1e9 + 0.123 + k * step;
    worstClock = Math.max(worstClock, Math.abs(t.timeAt(k / 4) - exact));
    worstSum = Math.max(worstSum, Math.abs(sum - exact));
    sum += step;
  }
  assert.ok(worstClock < 1e-6, `clock error ${worstClock}`);
  assert.ok(worstClock <= worstSum, 'no worse than a running sum');
});

test('no drift across tempo changes: 12,000 steps match the closed form', () => {
  const t = new Transport({ bpm: 120 });
  t.start({ at: 0 });
  t.setTempo(90, 1000); t.setTempo(150, 2000);
  for (let k = 0; k < 12000; k++) {
    const b = k / 4;
    const exact = b <= 1000 ? b * 0.5 : b <= 2000 ? 500 + (b - 1000) * 60 / 90 : 500 + 1000 * 60 / 90 + (b - 2000) * 60 / 150;
    near(t.timeAt(b), exact, 1e-7);
  }
});

test('transport: scheduled start and stop, frozen beat while stopped, bars from the meter', () => {
  const t = new Transport({ bpm: 120, meter: { beatsPerBar: 3, beatUnit: 4 } });
  assert.equal(t.beatAt(5), 0);
  t.start({ at: 2, beat: 6 });
  assert.equal(t.isPlayingAt(1.99), false); assert.equal(t.isPlayingAt(2), true);
  near(t.beatAt(3), 8);
  assert.deepEqual(t.position(7.5), { beat: 7.5, bar: 2, beatInBar: 1.5, barPhase: 0.5 });
  assert.equal(t.nextBar(7.5), 9); assert.equal(t.nextBar(9), 9); assert.equal(t.nextBar(9, true), 12);
  t.stop({ at: 4 });
  near(t.beatAt(10), 10); near(t.stoppedBeat, 10); assert.equal(t.isPlayingAt(4), false);
  assert.equal(nextGridBeat(1.01, 0.25), 1.25);
});

test('snapshot: JSON round trip gives identical beat and time answers', () => {
  const t = new Transport({ bpm: 111, meter: { beatsPerBar: 7, beatUnit: 8 } });
  t.start({ at: 1761580000.25, beat: 2 });
  t.setTempo(95, 10); t.setTempo(140.5, 33.25); t.tempo.rampTempo(70, 40, 8);
  const snap = toSnapshot(t, 'shared');
  const json = JSON.parse(JSON.stringify(snap));
  assert.equal(json.version, SNAPSHOT_VERSION);
  const u = fromSnapshot(validateSnapshot(json));
  for (let b = -3; b < 80; b += 0.173) assert.equal(u.timeAt(b), t.timeAt(b));
  for (let s = 1761579999; s < 1761580040; s += 0.0917) assert.equal(u.beatAt(s), t.beatAt(s));
  assert.deepEqual(toSnapshot(u, 'shared'), snap);
  t.stop({ at: 1761580030 });
  const v = fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(t))));
  assert.equal(v.beatAt(1761580050), t.beatAt(1761580050)); assert.equal(v.stopTime, t.stopTime);
});

test('snapshot: shifting to another timeline moves times, not beats', () => {
  const t = new Transport({ bpm: 120 }); t.start({ at: 100 }); t.setTempo(60, 4);
  const local = fromSnapshot(shiftSnapshot(toSnapshot(t, 'shared'), -97.5, 'audio'));
  near(local.timeAt(4), t.timeAt(4) - 97.5); near(local.beatAt(5), t.beatAt(102.5));
  assert.throws(() => validateSnapshot({ format: 'nc-clock/snapshot', version: 2 }), /version/);
  assert.throws(() => validateSnapshot({ ...toSnapshot(t), tempo: [] }), /tempo/);
});

test('NcClock: standalone applies at once; with an authority calls become requests', () => {
  const clock = new NcClock({ bpm: 120 });
  const changes: string[] = [];
  clock.onChange(c => changes.push(c.kind));
  assert.equal(clock.play({ at: 1 }), true);
  assert.equal(clock.setTempo({ bpm: 90, atBeat: 4 }), true);
  near(clock.transport.timeAt(5), 3 + 60 / 90);
  const asked: string[] = [];
  clock.setAuthority({ requestStart: () => asked.push('start'), requestStop: () => asked.push('stop'), requestTempo: r => asked.push(`tempo ${r.bpm}`) });
  assert.equal(clock.stop({ at: 5 }), false);
  assert.equal(clock.setTempo({ bpm: 100 }), false);
  assert.deepEqual(asked, ['stop', 'tempo 100']);
  assert.equal(clock.transport.running, true, 'nothing changed until the authority commits');
  clock.commitStop(5);
  assert.deepEqual(changes, ['start', 'tempo', 'stop']);
});
