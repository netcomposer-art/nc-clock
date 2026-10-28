// Per-instrument Stop (nc-clock 0.5.0, NC Sync capability `independentStop`). P1 from live netcomposer.art: Stop in
// any instrument tab stopped all of them (requestStop -> leader decideStop -> commitStop on the shared transport ->
// every peer applied `state` with playing:false). Now Stop is a member state; the session ends with the last one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NcClock, type ClockChange } from '../src/core/index.js';
import { NcSyncPeer, type ChannelLike, type LocksLike } from '../src/peer.js';
import type { NcSyncMessage, StateMessage } from '../src/protocol.js';

function hub() {
  const members = new Set<ChannelLike>();
  const log: NcSyncMessage[] = [];
  return {
    log,
    channel(): ChannelLike {
      const ch: ChannelLike = {
        onmessage: null,
        postMessage(data: unknown) { const copy = JSON.parse(JSON.stringify(data)); log.push(copy); for (const m of members) if (m !== ch) queueMicrotask(() => m.onmessage?.({ data: copy })); },
        close() { members.delete(ch); },
      };
      members.add(ch);
      return ch;
    },
  };
}
function fakeLocks(): LocksLike {
  let held = false;
  const queue: (() => void)[] = [];
  const next = () => { if (!held && queue.length) queue.shift()!(); };
  return {
    request(_name, options, callback) {
      return new Promise((resolve, reject) => {
        const run = () => { held = true; callback({}).then(resolve, reject).finally(() => { held = false; next(); }); };
        options.signal?.addEventListener('abort', () => { const i = queue.indexOf(run); if (i >= 0) { queue.splice(i, 1); reject(new Error('aborted')); } });
        queue.push(run); next();
      });
    },
  };
}
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

type Tab = { clock: NcClock; peer: NcSyncPeer; changes: ClockChange[] };
function tab(h: ReturnType<typeof hub>, app: string, now: { t: number }, o: { indep?: boolean; prefersLeader?: boolean; canLead?: boolean; swing?: () => number | null; locks?: LocksLike | null } = {}): Tab {
  const clock = new NcClock({ bpm: 120, timebase: 'shared' });
  const changes: ClockChange[] = [];
  clock.onChange(c => changes.push(c));
  const peer = new NcSyncPeer({ app, version: '0.0.0', clock, channel: h.channel(), locks: o.locks ?? null, now: () => now.t,
    heartbeatMs: 60_000, joinGraceMs: 0, instanceId: app, independentStop: o.indep ?? true, ...(o.swing ? { swing: o.swing } : {}),
    capabilities: { prefersLeader: !!o.prefersLeader, canLead: o.canLead ?? true, swing: !!o.swing } });
  return { clock, peer, changes };
}
const states = (h: ReturnType<typeof hub>) => h.log.filter((m): m is StateMessage => m.type === 'state');
const transportMsgs = (h: ReturnType<typeof hub>) => h.log.filter(m => m.type === 'transport');
const leaderOf = (...tabs: Tab[]) => tabs.filter(t => t.peer.isLeader).map(t => t.peer.id);
/** Beat times (s) a tab schedules for beats [from, to). */
const beatTimes = (t: Tab, from: number, to: number) => { const out: number[] = []; for (let b = from; b < to; b += 0.25) out.push(t.clock.transport.timeAt(b)); return out; };
/** The sync standard: pooled |error| p95 <= 1 ms and max <= 3 ms. */
function assertSyncGate(errorsMs: number[], label: string) {
  const sorted = [...errorsMs].map(Math.abs).sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0, max = sorted.at(-1) ?? 0;
  assert.ok(p95 <= 1 && max <= 3, `${label}: p95 ${p95} ms, max ${max} ms`);
}
const diffMs = (a: number[], b: number[]) => a.map((x, i) => (x - b[i]!) * 1000);

async function threeTabs(now: { t: number }, opts: { locks?: LocksLike | null; swingA?: () => number | null } = {}) {
  const h = hub();
  const a = tab(h, 'a-rhythm', now, { locks: opts.locks, ...(opts.swingA ? { swing: opts.swingA } : {}) }); await a.peer.start(); await flush();
  now.t += 1;
  const b = tab(h, 'b-bass', now, { locks: opts.locks }); await b.peer.start(); await flush();
  now.t += 1;
  const c = tab(h, 'c-synth', now, { locks: opts.locks }); await c.peer.start(); await flush();
  return { h, a, b, c };
}

test('standalone: clock.playing follows play and stop; no member changes', () => {
  const clock = new NcClock({ bpm: 120 });
  const kinds: string[] = [];
  clock.onChange(c => kinds.push(c.kind));
  assert.equal(clock.playing, false);
  clock.play({ at: 1 }); assert.equal(clock.playing, true); assert.equal(clock.isPlayingAt(2), true);
  clock.stop({ at: 3 }); assert.equal(clock.playing, false); assert.equal(clock.isPlayingAt(2), false);
  assert.deepEqual(kinds, ['start', 'stop']);
  assert.deepEqual(clock.joinPoint(1), { beat: 0, time: 1 }); // stopped at beat 0
});

test('local stop: Stop in B stops only B; A and C keep the exact same grid (no transport message, no beat jump)', async () => {
  const now = { t: 1000 };
  const { h, a, b, c } = await threeTabs(now);
  a.clock.play({ at: now.t }); await flush();
  now.t += 0.5; b.clock.play({ at: now.t }); await flush();
  now.t += 0.5; c.clock.play({ at: now.t }); await flush();
  for (const t of [a, b, c]) assert.equal(t.clock.playing, true, `${t.peer.id} plays`);
  assert.equal(transportMsgs(h).length, 0, 'B and C joined the running grid without asking the leader');
  const before = { a: beatTimes(a, 0, 64), c: beatTimes(c, 0, 64), snap: JSON.stringify(a.clock.toSnapshot()) };
  now.t += 1.3; const sent = transportMsgs(h).length, statesBefore = states(h).length;
  b.clock.stop({ at: now.t }); await flush();
  assert.equal(b.clock.playing, false); assert.equal(b.clock.isPlayingAt(now.t + 1), false);
  assert.equal(a.clock.playing, true); assert.equal(c.clock.playing, true);
  assert.equal(transportMsgs(h).length, sent, 'no transport stop on the wire');
  assert.equal(states(h).length, statesBefore, 'the leader did not touch the session');
  assert.ok(a.clock.transport.running && b.clock.transport.running && c.clock.transport.running, 'the session grid runs on every tab');
  assert.equal(JSON.stringify(a.clock.toSnapshot()), before.snap);
  assertSyncGate([...diffMs(beatTimes(a, 0, 64), before.a), ...diffMs(beatTimes(c, 0, 64), before.c), ...diffMs(beatTimes(a, 0, 64), beatTimes(c, 0, 64))], 'A,C after B stops');
  const member = b.changes.filter(x => x.kind === 'member');
  assert.deepEqual(member.map(x => (x as { playing: boolean }).playing), [true, false], 'B heard its own member changes');
  assert.equal(a.peer.peers.get('b-bass')?.playing, false, 'peers list carries member state');
  for (const t of [a, b, c]) t.peer.stop();
});

test('Play while others play is a Join on the next grid line: zero beat jump for the running tabs', async () => {
  const now = { t: 2000 };
  const { h, a, b, c } = await threeTabs(now);
  a.clock.play({ at: now.t }); await flush();
  now.t += 0.4; c.clock.play({ at: now.t }); await flush();
  const start = a.clock.transport.startTime;
  const ref = { a: beatTimes(a, 0, 128), c: beatTimes(c, 0, 128) };
  now.t += 3.37; // late, mid-beat
  b.clock.play({ at: now.t }); await flush();
  assert.equal(b.clock.playing, true);
  assert.equal(a.clock.transport.startTime, start, 'the grid did not restart');
  assert.equal(transportMsgs(h).filter(m => m.from === 'b-bass').length, 0);
  const join = b.clock.joinPoint(now.t);
  assert.ok(Number.isInteger(join.beat) && join.time >= now.t - 1e-9 && join.time - now.t < 0.5 + 1e-9, `next whole beat ${JSON.stringify(join)}`);
  const join16 = b.clock.joinPoint(now.t, 0.25);
  assert.ok(Math.abs(join16.beat * 4 - Math.round(join16.beat * 4)) < 1e-9, 'a 16th grid joins on a 16th');
  assertSyncGate([...diffMs(beatTimes(a, 0, 128), ref.a), ...diffMs(beatTimes(c, 0, 128), ref.c),
    ...diffMs(beatTimes(b, 0, 128), ref.a)], 'A,C unchanged; B on the shared grid');
  for (const t of [a, b, c]) t.peer.stop();
});

test('the session ends only when the last instrument stops; a Play before it lands keeps the run', async () => {
  const now = { t: 3000 };
  const { h, a, b, c } = await threeTabs(now);
  for (const t of [a, b, c]) { t.clock.play({ at: now.t }); await flush(); now.t += 0.3; }
  const start = a.clock.transport.startTime;
  b.clock.stop({ at: now.t }); await flush();
  a.clock.stop({ at: now.t }); await flush();
  assert.ok(c.clock.transport.running, 'one instrument still plays');
  c.clock.stop({ at: now.t }); await flush();
  for (const t of [a, b, c]) { assert.equal(t.clock.transport.running, false, `${t.peer.id}: session ended`); assert.equal(t.clock.playing, false); }
  const end = states(h).at(-1)!;
  assert.equal(end.independentStop, true); assert.equal(end.endSession, undefined); assert.equal(end.clock.playing, false);
  // Pressed Play inside the stop's 0.1 s lead: the same run carries on (no restart from beat 0).
  now.t += 0.05; b.clock.play({ at: now.t }); await flush();
  assert.equal(b.clock.transport.running, true); assert.equal(b.clock.transport.startTime, start, 'resumed the same run');
  assert.equal(a.clock.transport.startTime, start);
  b.clock.stop({ at: now.t }); await flush();
  // After the end, Play starts a new session (beat 0, now + lead) as before.
  now.t += 5; c.clock.play({ at: now.t }); await flush();
  assert.ok(Math.abs(a.clock.transport.startTime! - (now.t + 0.2)) < 1e-9);
  assert.equal(a.clock.playing, false, 'a new session does not start the other instruments');
  for (const t of [a, b, c]) t.peer.stop();
});

test('a tab that joins as the session ends gets the run back (no instrument left on a stopped grid)', async () => {
  const now = { t: 3500 };
  const { a, b, c } = await threeTabs(now);
  a.clock.play({ at: now.t }); await flush();
  const start = a.clock.transport.startTime;
  now.t += 1;
  // A stops while C presses Play on what it still sees as a running grid (crossing messages).
  c.clock.play({ at: now.t }); a.clock.stop({ at: now.t }); await flush();
  assert.equal(c.clock.playing, true);
  for (const t of [a, b, c]) assert.equal(t.clock.transport.running, true, `${t.peer.id}: running`);
  assert.equal(c.clock.transport.startTime, start);
  for (const t of [a, b, c]) t.peer.stop();
});

for (const locks of [false, true]) {
  test(`leader stop hands off to a playing peer: anchor unchanged, term + 1, swing carried${locks ? ' (Web Locks)' : ''}`, async () => {
    const now = { t: 4000 };
    const { h, a, b, c } = await threeTabs(now, { locks: locks ? fakeLocks() : null, swingA: () => 0.62 });
    await flush();
    assert.deepEqual(leaderOf(a, b, c), ['a-rhythm']);
    a.clock.play({ at: now.t }); await flush();
    now.t += 0.7; b.clock.play({ at: now.t }); await flush();
    now.t += 0.7; c.clock.play({ at: now.t }); await flush();
    assert.equal(b.peer.swing, 0.62);
    const snap = a.clock.toSnapshot(), term = a.peer.term;
    const ref = { b: beatTimes(b, 0, 64), c: beatTimes(c, 0, 64) };
    now.t += 0.9; a.clock.stop({ at: now.t }); await flush(60);
    assert.deepEqual(leaderOf(a, b, c), ['b-bass'], 'the earliest-joined playing peer leads');
    const handoff = states(h).filter(m => m.from === 'b-bass').at(-1)!;
    assert.ok(handoff.term > term, `term ${term} -> ${handoff.term}`);
    if (!locks) assert.equal(handoff.term, term + 1, 'exactly one term bump');
    assert.deepEqual(handoff.clock.anchor, snap.anchor, 'anchor unchanged');
    assert.deepEqual(handoff.clock.tempo, snap.tempo, 'tempo map unchanged');
    assert.equal(handoff.clock.startTime, snap.startTime);
    assert.equal(handoff.swing, 0.62, 'the session swing carried (B has no swing of its own)');
    for (const t of [a, b, c]) assert.equal(t.peer.swing, 0.62);
    assert.equal(a.clock.playing, false); assert.ok(b.clock.playing && c.clock.playing);
    assert.ok(a.clock.transport.running, 'the session plays on');
    assertSyncGate([...diffMs(beatTimes(b, 0, 64), ref.b), ...diffMs(beatTimes(c, 0, 64), ref.c), ...diffMs(beatTimes(a, 0, 64), ref.b)], 'handoff');
    // Restart A: a Join on the grid (no restart, it does not take the lead back from a playing peer unless it prefers).
    now.t += 1.1; a.clock.play({ at: now.t }); await flush(60);
    assert.equal(a.clock.transport.startTime, snap.startTime);
    assertSyncGate(diffMs(beatTimes(a, 0, 64), ref.b), 'A rejoins');
    // Stop each individually: the session ends with the last.
    for (const t of [b, a, c]) { now.t += 0.5; t.clock.stop({ at: now.t }); await flush(60); }
    for (const t of [a, b, c]) assert.equal(t.clock.transport.running, false, `${t.peer.id}: ended`);
    assert.equal(leaderOf(a, b, c).length, 1, 'one leader');
    for (const t of [a, b, c]) t.peer.stop();
  });
}

test('a peer that cannot lead (ASTRID) never takes the lead; the stopped leader keeps leading for it', async () => {
  const now = { t: 4500 };
  const h = hub();
  const r = tab(h, 'rhythm', now, { prefersLeader: true }); await r.peer.start(); await flush();
  const s = tab(h, 'synth', now, { canLead: false }); await s.peer.start(); await flush();
  r.clock.play({ at: now.t }); await flush();
  s.clock.play({ at: now.t }); await flush();
  r.clock.stop({ at: now.t }); await flush();
  assert.equal(r.peer.isLeader, true); assert.equal(s.peer.isLeader, false);
  assert.equal(r.clock.transport.running, true, 'ASTRID still plays');
  s.clock.stop({ at: now.t }); await flush();
  assert.equal(r.clock.transport.running, false, 'ASTRID was the last');
  r.peer.stop(); s.peer.stop();
});

test('stop({ all: true }) is still a session stop for everyone (stopAll + endSession)', async () => {
  const now = { t: 5000 };
  const { h, a, b, c } = await threeTabs(now);
  for (const t of [a, b, c]) { t.clock.play({ at: now.t }); await flush(); }
  now.t += 1; c.clock.stop({ at: now.t, all: true }); await flush();
  const last = states(h).at(-1)!;
  assert.equal(last.stopAll, true); assert.equal(last.endSession, true);
  for (const t of [a, b, c]) { assert.equal(t.clock.transport.running, false); assert.equal(t.clock.playing, false, `${t.peer.id} stopped`); }
  assert.ok(a.changes.some(x => x.kind === 'stop' && x.all), 'free-running parts hear all');
  for (const t of [a, b, c]) t.peer.stop();
});

test('mixed versions: an older peer\'s Stop stops everyone; new Stops never end a session an older peer plays in', async () => {
  const now = { t: 6000 };
  const h = hub();
  const a = tab(h, 'a-new', now); await a.peer.start(); await flush();
  now.t += 1;
  const old = tab(h, 'b-old', now, { indep: false }); await old.peer.start(); await flush(); // 0.4.0 wire and behaviour (no independentStop)
  now.t += 1;
  const c = tab(h, 'c-new', now); await c.peer.start(); await flush();
  assert.ok(!h.log.some(m => m.from === 'b-old' && ('playing' in m || 'independentStop' in m)), 'the old peer speaks the 0.4.0 wire');
  assert.equal(a.peer.peers.get('b-old')?.playing, null);
  a.clock.play({ at: now.t }); await flush();
  c.clock.play({ at: now.t }); await flush();
  assert.equal(old.clock.playing, true, 'an older peer plays whenever the session does (as today)');
  a.clock.stop({ at: now.t }); c.clock.stop({ at: now.t }); await flush();
  assert.equal(a.clock.transport.running, true, 'the older peer is still playing');
  assert.deepEqual(leaderOf(a, old, c), ['a-new'], 'mixed session keeps the 0.4.0 ranking: one leader, no handoff');
  c.clock.play({ at: now.t }); await flush();
  now.t += 0.6; old.clock.stop({ at: now.t }); await flush();
  const last = states(h).at(-1)!;
  assert.equal(last.endSession, true);
  for (const t of [a, old, c]) { assert.equal(t.clock.transport.running, false); assert.equal(t.clock.playing, false, `${t.peer.id} stopped`); }
  // An older peer's Play on a running session is a Join too (the new leader never restarts the grid).
  c.clock.play({ at: now.t }); await flush();
  const start = a.clock.transport.startTime;
  now.t += 1.3; old.clock.play({ at: now.t }); await flush();
  assert.equal(a.clock.transport.startTime, start);
  for (const t of [a, old, c]) t.peer.stop();
});

test('mixed versions: an older leader with new followers', async () => {
  const now = { t: 7000 };
  const h = hub();
  const old = tab(h, 'a-old', now, { indep: false, prefersLeader: true }); await old.peer.start(); await flush();
  const b = tab(h, 'b-new', now); await b.peer.start(); await flush();
  const c = tab(h, 'c-new', now); await c.peer.start(); await flush();
  assert.deepEqual(leaderOf(old, b, c), ['a-old']);
  b.clock.play({ at: now.t }); await flush();
  assert.equal(old.clock.transport.running, true, 'the old leader started the session');
  c.clock.play({ at: now.t }); await flush();
  const start = old.clock.transport.startTime;
  assert.equal(c.clock.transport.startTime, start, 'C joined without a restart request');
  b.clock.stop({ at: now.t }); await flush();
  assert.ok(old.clock.transport.running && c.clock.playing, 'B stopped alone');
  assert.equal(transportMsgs(h).filter(m => (m as { action: string }).action === 'stop').length, 0);
  now.t += 1; old.clock.stop({ at: now.t }); await flush();
  for (const t of [b, c]) assert.equal(t.clock.playing, false, `${t.peer.id}: the old leader's Stop stops everyone`);
  for (const t of [old, b, c]) t.peer.stop();
});

test('a playing peer that vanishes is counted out: the session ends without it', async () => {
  const now = { t: 8000 };
  const h = hub();
  const a = tab(h, 'a', now); await a.peer.start(); await flush();
  const b = tab(h, 'b', now); await b.peer.start(); await flush();
  b.clock.play({ at: now.t }); await flush();
  assert.equal(a.clock.transport.running, true);
  const g = b.peer as unknown as { channel: ChannelLike };
  g.channel.close(); g.channel = { postMessage() {}, onmessage: null, close() {} };
  now.t += 4; (a.peer as unknown as { beat(): void }).beat(); await flush();
  assert.equal(a.clock.transport.running, false);
  a.peer.stop(); b.peer.stop();
});
