// Per-instrument Stop (nc-clock 0.5.0, NC Sync capability `independentStop`). P1 from live netcomposer.art: Stop in
// any instrument tab stopped all of them (requestStop -> leader decideStop -> commitStop on the shared transport ->
// every peer applied `state` with playing:false). Now Stop is a member state; the session ends with the last one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NcClock, type ClockChange } from '../src/core/index.js';
import { NcSyncPeer, type ChannelLike, type LocksLike } from '../src/peer.js';
import { PROTOCOL, type NcSyncMessage, type StateMessage } from '../src/protocol.js';

function hub() {
  const members = new Set<ChannelLike>();
  const log: NcSyncMessage[] = [];
  const hub = {
    log,
    /** Lose matching messages in transit (a test of the paths that must not depend on them). */
    drop: null as ((m: NcSyncMessage) => boolean) | null,
    channel(): ChannelLike {
      const ch: ChannelLike = {
        onmessage: null,
        postMessage(data: unknown) { const copy = JSON.parse(JSON.stringify(data)); log.push(copy); if (hub.drop?.(copy)) return; for (const m of members) if (m !== ch) queueMicrotask(() => m.onmessage?.({ data: copy })); },
        close() { members.delete(ch); },
      };
      members.add(ch);
      return ch;
    },
  };
  return hub;
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

for (const locks of [false, true]) test(`the session ends only when the last instrument stops; a Play before it lands keeps the run${locks ? ' (Web Locks)' : ''}`, async () => {
  const now = { t: 3000 };
  const { h, a, b, c } = await threeTabs(now, { locks: locks ? fakeLocks() : null });
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
  now.t += 0.05; b.clock.play({ at: now.t }); await flush(60);
  assert.equal(b.clock.transport.running, true); assert.equal(b.clock.transport.startTime, start, 'resumed the same run');
  assert.equal(a.clock.transport.startTime, start);
  b.clock.stop({ at: now.t }); await flush(60);
  // After the end, Play starts a new session (beat 0, now + lead) as before.
  now.t += 5; c.clock.play({ at: now.t }); await flush(60);
  assert.ok(Math.abs(a.clock.transport.startTime! - (now.t + 0.2)) < 1e-9);
  for (const t of [a, b, c]) assert.equal(t.clock.transport.running, true, `${t.peer.id}: the new session runs`);
  assert.equal(a.clock.playing, false, 'a new session does not start the other instruments');
  assert.equal(leaderOf(a, b, c).length, 1, 'one leader');
  for (const t of [a, b, c]) t.peer.stop();
});

for (const locks of [false, true]) for (const loseStart of [false, true]) {
  test(`a tab that joins as the session ends gets the same run back${loseStart ? ', even if its start request is lost' : ''}${locks ? ' (Web Locks)' : ''}`, async () => {
    const now = { t: 3500 };
    const { h, a, b, c } = await threeTabs(now, { locks: locks ? fakeLocks() : null });
    a.clock.play({ at: now.t }); await flush(60);
    const start = a.clock.transport.startTime;
    const ref = beatTimes(c, 0, 64);
    now.t += 1;
    // The keep-run must not hang on C's start request: the leader also keeps it on C's playing heartbeat.
    if (loseStart) h.drop = m => m.type === 'transport';
    const from = h.log.length;
    // A stops while C presses Play on what it still sees as a running grid (crossing messages).
    c.clock.play({ at: now.t }); a.clock.stop({ at: now.t }); await flush(60);
    assert.equal(c.clock.playing, true);
    for (const t of [a, b, c]) assert.equal(t.clock.transport.running, true, `${t.peer.id}: running`);
    // The same run, never a restart: C does not play the old grid only to jump to a new one (no state with another start).
    assert.equal(c.clock.transport.startTime, start);
    assert.ok(h.log.slice(from).every(m => m.type !== 'state' || m.clock.startTime === start), 'no state carried a new run');
    assertSyncGate(diffMs(beatTimes(c, 0, 64), ref), 'C on the kept run');
    assert.equal(leaderOf(a, b, c).length, 1, 'one leader');
    for (const t of [a, b, c]) t.peer.stop();
  });
}

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

for (const locks of [false, true]) {
  const sfx = locks ? ' (Web Locks)' : '';
  test(`mixed versions: a new peer's Stop stops everyone (the 0.4.0 session stop, not all); an older peer's too${sfx}`, async () => {
    const now = { t: 6000 };
    const h = hub();
    const L = locks ? fakeLocks() : null;
    const a = tab(h, 'a-new', now, { locks: L }); await a.peer.start(); await flush();
    now.t += 1;
    const old = tab(h, 'b-old', now, { indep: false, locks: L }); await old.peer.start(); await flush(); // 0.4.0 wire and behaviour (no independentStop)
    now.t += 1;
    const c = tab(h, 'c-new', now, { locks: L }); await c.peer.start(); await flush(60);
    assert.ok(!h.log.some(m => m.from === 'b-old' && ('playing' in m || 'independentStop' in m)), 'the old peer speaks the 0.4.0 wire');
    assert.equal(a.peer.peers.get('b-old')?.playing, null);
    assert.deepEqual(leaderOf(a, old, c), ['a-new']);
    const stopAllSeen = () => h.log.some(m => m.type === 'state' && m.stopAll) || h.log.some(m => m.type === 'transport' && (m as { all?: boolean }).all);
    // 1. The new leader's Stop.
    a.clock.play({ at: now.t }); await flush(60);
    c.clock.play({ at: now.t }); await flush(60);
    assert.equal(old.clock.playing, true, 'an older peer plays whenever the session does (as today)');
    now.t += 1; a.clock.stop({ at: now.t }); await flush(60);
    for (const t of [a, old, c]) { assert.equal(t.clock.transport.running, false, `${t.peer.id}: stopped`); assert.equal(t.clock.playing, false, `${t.peer.id} stopped`); }
    assert.equal(states(h).at(-1)!.endSession, true, 'a session stop for everyone');
    assert.ok(!stopAllSeen(), 'not `all`: free-running parts (a latched arp) keep their state');
    assert.ok(!c.changes.some(x => x.kind === 'stop' && x.all));
    assert.deepEqual(leaderOf(a, old, c), ['a-new'], 'mixed session keeps the 0.4.0 ranking: one leader, no handoff');
    // 2. A new follower's Stop (a transport stop request to the leader, as in 0.4.0).
    now.t += 1; a.clock.play({ at: now.t }); await flush(60);
    c.clock.play({ at: now.t }); await flush(60);
    now.t += 1; c.clock.stop({ at: now.t }); await flush(60);
    for (const t of [a, old, c]) { assert.equal(t.clock.transport.running, false, `${t.peer.id}: stopped by C`); assert.equal(t.clock.playing, false); }
    assert.ok(!stopAllSeen());
    // 3. The older peer's Stop stops everyone; its Play on a running session is a Join (no restart).
    now.t += 1; c.clock.play({ at: now.t }); await flush(60);
    a.clock.play({ at: now.t }); await flush(60);
    const start = a.clock.transport.startTime;
    now.t += 1.3; old.clock.play({ at: now.t }); await flush(60);
    assert.equal(a.clock.transport.startTime, start, 'the old peer joined');
    now.t += 0.6; old.clock.stop({ at: now.t }); await flush(60);
    assert.equal(states(h).at(-1)!.endSession, true);
    for (const t of [a, old, c]) { assert.equal(t.clock.transport.running, false); assert.equal(t.clock.playing, false, `${t.peer.id} stopped`); }
    // 4. The peer set changes: once the older peer leaves, Stop is per instrument again.
    old.peer.stop(); await flush(60);
    now.t += 1; a.clock.play({ at: now.t }); await flush(60);
    c.clock.play({ at: now.t }); await flush(60);
    now.t += 1; c.clock.stop({ at: now.t }); await flush(60);
    assert.ok(a.clock.playing && a.clock.transport.running && !c.clock.playing, 'C stopped alone');
    assert.equal(c.clock.transport.running, true);
    // ... and a newcomer without the capability makes it a session stop again.
    const old2 = tab(h, 'd-old', now, { indep: false, locks: L }); await old2.peer.start(); await flush(60);
    now.t += 1; c.clock.play({ at: now.t }); await flush(60);
    now.t += 1; c.clock.stop({ at: now.t }); await flush(60);
    for (const t of [a, c, old2]) assert.equal(t.clock.transport.running, false, `${t.peer.id}: stopped again`);
    assert.equal(a.clock.playing, false);
    for (const t of [a, c, old2]) t.peer.stop();
  });

  test(`mixed versions: an older leader's Stop stops everyone, and so does a new follower's${sfx}`, async () => {
    const now = { t: 7000 };
    const h = hub();
    const L = locks ? fakeLocks() : null;
    const old = tab(h, 'a-old', now, { indep: false, prefersLeader: true, locks: L }); await old.peer.start(); await flush();
    const b = tab(h, 'b-new', now, { locks: L }); await b.peer.start(); await flush();
    const c = tab(h, 'c-new', now, { locks: L }); await c.peer.start(); await flush(60);
    assert.deepEqual(leaderOf(old, b, c), ['a-old']);
    b.clock.play({ at: now.t }); await flush(60);
    assert.equal(old.clock.transport.running, true, 'the old leader started the session');
    c.clock.play({ at: now.t }); await flush(60);
    const start = old.clock.transport.startTime;
    assert.equal(c.clock.transport.startTime, start, 'C joined without a restart request');
    // A new follower's Stop: a session stop for everyone (the old leader stops it, as in 0.4.0).
    now.t += 1; b.clock.stop({ at: now.t }); await flush(60);
    for (const t of [old, b, c]) { assert.equal(t.clock.transport.running, false, `${t.peer.id}: stopped by B`); assert.equal(t.clock.playing, false); }
    assert.ok(transportMsgs(h).some(m => m.from === 'b-new' && (m as { action: string; all?: boolean }).action === 'stop' && !(m as { all?: boolean }).all), 'a plain stop request, not all');
    // The old leader's own Stop.
    now.t += 1; b.clock.play({ at: now.t }); await flush(60);
    c.clock.play({ at: now.t }); await flush(60);
    now.t += 1; old.clock.stop({ at: now.t }); await flush(60);
    for (const t of [old, b, c]) { assert.equal(t.clock.transport.running, false); assert.equal(t.clock.playing, false, `${t.peer.id}: the old leader's Stop stops everyone`); }
    for (const t of [old, b, c]) t.peer.stop();
  });
}

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

// ---- Zeta review @338b291, P1: a Play in a non-leading tab must start the session, Web Locks included ----------
// requestStart used to send the start to the old leader while its own heartbeat moved the lead (playing outranked
// stopped even with no session); the old leader released the lock and dropped the start, and the new leader only
// broadcast the stopped state: playing=true, running=false, 0 beats, forever.
const two = async (now: { t: number }, locks: boolean) => {
  const h = hub();
  const L = locks ? fakeLocks() : null;
  const a = tab(h, 'a-rhythm', now, { locks: L }); await a.peer.start(); await flush();
  now.t += 1;
  const b = tab(h, 'b-bass', now, { locks: L }); await b.peer.start(); await flush();
  return { h, a, b };
};
for (const locks of [false, true]) {
  const sfx = locks ? ' (Web Locks)' : '';
  test(`Play in a non-leading tab when no session runs starts the session${sfx}`, async () => {
    const now = { t: 9000 };
    const { a, b, c } = await threeTabs(now, { locks: locks ? fakeLocks() : null });
    assert.deepEqual(leaderOf(a, b, c), ['a-rhythm']);
    now.t += 1; b.clock.play({ at: now.t }); await flush(60);
    for (const t of [a, b, c]) assert.equal(t.clock.transport.running, true, `${t.peer.id}: running`);
    assert.ok(Math.abs(b.clock.transport.startTime! - (now.t + 0.2)) < 1e-9, 'a new session at now + lead');
    assert.ok(b.clock.playing && !a.clock.playing && !c.clock.playing, 'only B plays');
    assert.equal(leaderOf(a, b, c).length, 1, 'one leader');
    // Then the other non-leader joins; the session ends with the last Stop.
    now.t += 0.7; c.clock.play({ at: now.t }); await flush(60);
    assert.equal(c.clock.transport.startTime, b.clock.transport.startTime, 'C joined the same run');
    for (const t of [b, c]) { now.t += 0.5; t.clock.stop({ at: now.t }); await flush(60); }
    for (const t of [a, b, c]) assert.equal(t.clock.transport.running, false, `${t.peer.id}: ended`);
    for (const t of [a, b, c]) t.peer.stop();
  });
  for (const order of ['playFirst', 'stopFirst'] as const) {
    test(`the leader stops while the other tab presses Play (${order}): the run carries on for it${sfx}`, async () => {
      const now = { t: 9500 };
      const { a, b } = await two(now, locks);
      a.clock.play({ at: now.t }); await flush(50);
      const start = a.clock.transport.startTime;
      now.t += 1;
      if (order === 'playFirst') { b.clock.play({ at: now.t }); a.clock.stop({ at: now.t }); }
      else { a.clock.stop({ at: now.t }); b.clock.play({ at: now.t }); }
      await flush(80); now.t += 0.5; await flush(80);
      assert.ok(b.clock.playing && !a.clock.playing);
      for (const t of [a, b]) { assert.equal(t.clock.transport.running, true, `${t.peer.id}: running`); assert.equal(t.clock.transport.startTime, start, 'same run'); }
      assert.equal(leaderOf(a, b).length, 1, 'one leader');
      a.peer.stop(); b.peer.stop();
    });
  }
  for (const gap of [0.05, 5]) {
    test(`after the session ended (Play ${gap} s later), a follower's Play ${gap < 0.1 ? 'keeps the run' : 'starts a new session'}${sfx}`, async () => {
      const now = { t: 9800 };
      const { a, b } = await two(now, locks);
      a.clock.play({ at: now.t }); await flush(50);
      const start = a.clock.transport.startTime;
      now.t += 1; a.clock.stop({ at: now.t }); await flush(80);
      assert.equal(a.clock.transport.running, false);
      now.t += gap; b.clock.play({ at: now.t }); await flush(80);
      now.t += 0.5; await flush(50);
      for (const t of [a, b]) assert.equal(t.clock.transport.running, true, `${t.peer.id}: running`);
      if (gap < 0.1) assert.equal(b.clock.transport.startTime, start, 'inside the stop lead: the same run');
      else assert.ok(Math.abs(b.clock.transport.startTime! - (now.t - 0.5 + 0.2)) < 1e-9, 'a new session at Play + lead');
      assert.ok(b.clock.playing && !a.clock.playing);
      assert.equal(leaderOf(a, b).length, 1, 'one leader');
      a.peer.stop(); b.peer.stop();
    });
  }
  test(`a tab that leaves never re-elects itself while leaving (P3a)${sfx}`, async () => {
    const now = { t: 10_000 };
    const { h, a, b } = await two(now, locks);
    await flush(30);
    assert.equal(a.peer.isLeader, true);
    // A third peer that went silent: A's leaving beat times it out, which re-ran the election on A itself.
    h.log.length = 0;
    (a.peer as unknown as { receive(m: unknown): void }).receive({ proto: PROTOCOL, type: 'heartbeat', from: 'z-ghost', seq: 1, term: 0, sentAt: now.t,
      app: 'ghost', leader: false, audio: 'none', hidden: false, joinedAt: now.t, outputLatencyMs: null, capabilities: { canLead: false } });
    assert.ok(a.peer.peers.has('z-ghost'));
    now.t += 10;
    let roles: string[] = [];
    a.peer.onRole(r => roles.push(r));
    a.peer.stop(); await flush(60);
    assert.deepEqual(roles, ['follower'], 'one role change: leader -> follower, never back');
    assert.equal(a.peer.isLeader, false);
    assert.ok(!h.log.some(m => m.from === 'a-rhythm' && m.type === 'state'), 'the leaving tab sent no state');
    now.t += 0.1; await flush(60);
    assert.equal(b.peer.isLeader, true, 'B takes over');
    roles = [];
    b.peer.stop();
  });
}

// ---- Petra on d5d7b86: session swing edits must not depend on who leads ----------------------------------------
// A follower's Play moves the lead to it (playing first); the stopped ex-leader's later swing edit used to go nowhere
// (only the leader publishes swing). publishState() on a follower now sends the edit to the leader (in a heartbeat).
for (const locks of [false, true]) {
  const sfx = locks ? ' (Web Locks)' : '';
  test(`a stopped ex-leader's swing edit reaches every peer${sfx}`, async () => {
    const now = { t: 11_000 };
    let swingA = 0.62;
    const { a, b, c } = await threeTabs(now, { locks: locks ? fakeLocks() : null, swingA: () => swingA });
    a.clock.play({ at: now.t }); await flush(60);
    now.t += 0.5; b.clock.play({ at: now.t }); await flush(60);
    now.t += 0.5; a.clock.stop({ at: now.t }); await flush(80);
    assert.deepEqual(leaderOf(a, b, c), ['b-bass'], 'the lead moved to the playing tab');
    for (const t of [a, b, c]) assert.equal(t.peer.swing, 0.62);
    swingA = 0.55;
    assert.equal(a.peer.publishState(), true, 'a follower forwards its edit');
    await flush(60);
    for (const t of [a, b, c]) assert.equal(t.peer.swing, 0.55, `${t.peer.id} has the edit`);
    // The edit is the session swing from then on, also after the next handoff.
    now.t += 1; a.clock.play({ at: now.t }); await flush(60);
    now.t += 0.5; b.clock.stop({ at: now.t }); await flush(80);
    assert.equal(leaderOf(a, b, c).length, 1);
    for (const t of [a, b, c]) assert.equal(t.peer.swing, 0.55, `${t.peer.id} after the next handoff`);
    for (const t of [a, b, c]) t.peer.stop();
  });

  test(`a swing edit during a handoff is not lost${sfx}`, async () => {
    const now = { t: 11_500 };
    let swingC = 0.5;
    const h = hub();
    const L = locks ? fakeLocks() : null;
    const a = tab(h, 'a-rhythm', now, { locks: L, swing: () => 0.62 }); await a.peer.start(); await flush();
    now.t += 1;
    const b = tab(h, 'b-bass', now, { locks: L }); await b.peer.start(); await flush();
    now.t += 1;
    const c = tab(h, 'c-synth', now, { locks: L, swing: () => swingC }); await c.peer.start(); await flush(60);
    a.clock.play({ at: now.t }); await flush(60);
    now.t += 0.5; b.clock.play({ at: now.t }); await flush(60);
    // A stops (the lead moves to B) while C edits swing: the edit crosses the handoff (it may reach A as it leaves).
    now.t += 0.5; swingC = 0.7;
    a.clock.stop({ at: now.t }); c.peer.publishState(); await flush(80);
    assert.deepEqual(leaderOf(a, b, c), ['b-bass']);
    for (const t of [a, b, c]) assert.equal(t.peer.swing, 0.7, `${t.peer.id}: the edit landed`);
    // And the other order: the edit first, the handoff on the same tick.
    now.t += 1; a.clock.play({ at: now.t }); await flush(60);
    now.t += 0.5; swingC = 0.58;
    c.peer.publishState(); b.clock.stop({ at: now.t }); await flush(80);
    assert.equal(leaderOf(a, b, c).length, 1);
    for (const t of [a, b, c]) assert.equal(t.peer.swing, 0.58, `${t.peer.id}: the second edit landed`);
    for (const t of [a, b, c]) t.peer.stop();
  });
}
