import test from 'node:test';
import assert from 'node:assert/strict';
import { NcClock } from '../src/core/index.js';
import { NcSyncPeer, type ChannelLike, type LocksLike } from '../src/peer.js';
import { parseMessage, envelope, PROTOCOL, type NcSyncMessage } from '../src/protocol.js';
import { AudioClockMapper, median } from '../src/audio-mapper.js';
import { createTicker } from '../src/ticker.js';

/** In-memory BroadcastChannel: delivers to every other member, asynchronously, in order. */
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
/** FIFO Web Locks with abort. */
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
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

function makePeer(h: ReturnType<typeof hub>, app: string, now: { t: number }, opts: { prefersLeader?: boolean; locks?: LocksLike | null; range?: [number, number] } = {}) {
  const clock = new NcClock({ bpm: 120, timebase: 'shared' });
  const peer = new NcSyncPeer({ app, version: '0.0.0', clock, channel: h.channel(), locks: opts.locks ?? null, now: () => now.t,
    heartbeatMs: 60_000, joinGraceMs: 0, capabilities: { prefersLeader: !!opts.prefersLeader, tempoRange: opts.range ?? [20, 300] }, instanceId: app });
  return { clock, peer };
}

test('protocol: validator accepts v1, drops other majors, malformed and unknown types', () => {
  const ok = envelope({ type: 'tempo', bpm: 100 } as never, 'a', 1, 1, 5);
  assert.equal((ok as { proto: string }).proto, PROTOCOL);
  assert.ok(parseMessage(ok));
  assert.equal(parseMessage({ ...ok, proto: 'nc-sync/2' }), null);
  assert.equal(parseMessage({ ...ok, bpm: 'fast' }), null);
  assert.equal(parseMessage({ ...ok, type: 'future-thing' }), null);
  assert.ok(parseMessage({ ...ok, extraField: true }), 'unknown fields ignored');
});

test('election without Web Locks: a prefersLeader peer leads even when it joins second', async () => {
  const h = hub(), now = { t: 1000 };
  const a = makePeer(h, 'synth', now);
  await a.peer.start(); await flush();
  assert.equal(a.peer.isLeader, true, 'alone: leads');
  now.t += 1;
  const r = makePeer(h, 'drums', now, { prefersLeader: true });
  await r.peer.start(); await flush();
  assert.equal(r.peer.isLeader, true); assert.equal(a.peer.isLeader, false);
  a.peer.stop(); r.peer.stop();
});

test('election with Web Locks: the follower yields the lock to a prefersLeader peer', async () => {
  const h = hub(), now = { t: 1000 }, locks = fakeLocks();
  const a = makePeer(h, 'synth', now, { locks });
  await a.peer.start(); await flush();
  assert.equal(a.peer.isLeader, true);
  const r = makePeer(h, 'drums', now, { prefersLeader: true, locks });
  await r.peer.start(); await flush();
  assert.equal(r.peer.isLeader, true); assert.equal(a.peer.isLeader, false);
  r.peer.stop(); await flush();
  assert.equal(a.peer.isLeader, true, 'takes over when the preferred leader leaves');
  a.peer.stop();
});

test('follower Play is a request; the leader decides; both clocks agree beat for beat', async () => {
  const h = hub(), now = { t: 5000 };
  const r = makePeer(h, 'drums', now, { prefersLeader: true }); await r.peer.start();
  const a = makePeer(h, 'synth', now); await a.peer.start(); await flush();
  assert.equal(a.clock.play({ at: now.t }), false);
  await flush();
  assert.equal(r.clock.transport.running, true);
  assert.equal(a.clock.transport.startTime, r.clock.transport.startTime);
  assert.ok(Math.abs(r.clock.transport.startTime! - (5000 + 0.2)) < 1e-9, 'nothing playing: start now + lead');
  // Restart while playing lands on the next bar.
  now.t += 1.3;
  a.clock.play({ at: now.t }); await flush();
  const t = r.clock.transport;
  assert.ok(Math.abs(t.startTime! - (5000.2 + 4 * 0.5)) < 1e-9, 'next bar line');
  // Tempo: lands on a whole beat at least minLead ahead, clamped to the shared range.
  a.clock.setTempo({ bpm: 90 }); await flush();
  assert.deepEqual(a.clock.transport.tempoPoints, r.clock.transport.tempoPoints);
  for (let b = 0; b < 32; b += 0.25) assert.equal(a.clock.transport.timeAt(b), t.timeAt(b));
  a.peer.stop(); r.peer.stop();
});

test('tempo range is the intersection of peers; late joiners get the full state', async () => {
  const h = hub(), now = { t: 100 };
  const r = makePeer(h, 'drums', now, { prefersLeader: true }); await r.peer.start();
  const a = makePeer(h, 'synth', now, { range: [20, 240] }); await a.peer.start(); await flush();
  r.clock.play({ at: now.t }); await flush();
  r.clock.setTempo({ bpm: 280 }); await flush();
  assert.equal(r.clock.transport.bpm, 240);
  const late = makePeer(h, 'late', now); await late.peer.start(); await flush();
  assert.deepEqual(late.clock.toSnapshot(), r.clock.toSnapshot());
  for (const p of [a, r, late]) p.peer.stop();
});

test('dedupe, stale terms and no echo', async () => {
  const h = hub(), now = { t: 1 };
  const r = makePeer(h, 'drums', now, { prefersLeader: true }); await r.peer.start();
  const a = makePeer(h, 'synth', now); await a.peer.start(); await flush();
  const got: number[] = [];
  a.peer.onSnapshot(m => got.push(m.slot));
  r.peer.sendSnapshot('recall', 3, { atBeat: 8, glide: { beats: 2 } }); await flush();
  const sent = h.log.filter(m => m.type === 'snapshot');
  assert.equal(sent.length, 1, 'receiver did not re-broadcast');
  // Replaying the same (from, seq) is ignored.
  (a.peer as unknown as { receive(d: unknown): void }).receive(sent[0]);
  assert.deepEqual(got, [3]);
  // A state from an older term is ignored.
  const before = JSON.stringify(a.clock.toSnapshot());
  const stale = envelope({ type: 'state', clock: { ...a.clock.toSnapshot(), stoppedBeat: 99 }, swing: 0, leaderApp: 'x' } as never, 'ghost', 0, 1, 1);
  (a.peer as unknown as { receive(d: unknown): void }).receive(stale);
  assert.equal(JSON.stringify(a.clock.toSnapshot()), before);
  a.peer.stop(); r.peer.stop();
});

test('audio mapper: median offset, guards zeros and suspended, re-reads latency', () => {
  let perf = 1000, ctxTime = 0, state = 'suspended';
  const ctx = { get currentTime() { return ctxTime; }, get state() { return state; }, outputLatency: 0.03, baseLatency: 0.005,
    getOutputTimestamp: () => ({ contextTime: ctxTime > 0 ? ctxTime - 0.03 : 0, performanceTime: ctxTime > 0 ? perf - 30 : 0 }) };
  const m = new AudioClockMapper(ctx, { timeOrigin: 1_700_000_000_000, perfNow: () => perf });
  assert.equal(m.sample(), false, 'suspended');
  state = 'running';
  assert.equal(m.sample(), false, 'zeros before the first rendered block');
  ctxTime = 2; perf = 3000;
  assert.equal(m.sample(), true);
  const expected = (2 - 0.03) - (1_700_000_000_000 + 2970) / 1000;
  assert.ok(Math.abs(m.offset - expected) < 1e-6);
  near(m.toSharedTime(m.toContextTime(1_700_000_005)), 1_700_000_005);
  assert.equal(m.outputLatencyMs, 30);
  m.userOffsetMs = 10; assert.ok(Math.abs(m.offset - expected - 0.01) < 1e-6);
  assert.equal(median([5, 1, 3]), 3); assert.equal(median([4, 1, 3, 2]), 2.5);
});
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);

test('ticker: falls back to a timer outside a browser and ticks', async () => {
  let n = 0;
  const t = createTicker(() => { n++; }, { intervalMs: 5 });
  assert.equal(t.kind, 'timer');
  t.start(); await new Promise(r => setTimeout(r, 60)); t.dispose();
  const after = n; await new Promise(r => setTimeout(r, 30));
  assert.ok(after >= 3, `ticked ${after}`); assert.equal(n, after, 'stopped');
});

test('a newcomer never competes with a running leader or disturbs followers (no Web Locks)', async () => {
  const h = hub(), now = { t: 7000 };
  const leader = makePeer(h, 'zz-drums', now, { prefersLeader: true }); await leader.peer.start(); await flush();
  const follower = makePeer(h, 'mm-synth', now); await follower.peer.start(); await flush();
  follower.clock.play({ at: now.t }); await flush();
  const start = leader.clock.transport.startTime;
  assert.equal(follower.clock.transport.startTime, start);
  // Joins with the lowest id, which would win a plain id tie-break.
  const late = makePeer(h, 'aa-looper', now); await late.peer.start(); await flush();
  assert.equal(leader.peer.isLeader, true);
  assert.equal(late.peer.isLeader, false);
  assert.ok(!h.log.some(m => m.type === 'state' && m.from === 'aa-looper'), 'the newcomer never broadcast a clock');
  assert.equal(late.clock.transport.startTime, start, 'the newcomer got the running clock');
  assert.equal(follower.clock.transport.startTime, start);
  // Its Play is a request to the existing leader (a restart on the next bar), not a local takeover.
  now.t += 0.5; late.clock.play({ at: now.t }); await flush();
  assert.equal(late.clock.transport.startTime, leader.clock.transport.startTime);
  assert.ok(leader.clock.transport.startTime! > start!);
  for (const p of [late, follower, leader]) p.peer.stop();
});

test('state.swing is the leader swing callback, and publishState delivers a change', async () => {
  const h = hub(), now = { t: 1000 };
  let swing = 0.5;
  const leaderClock = new NcClock({ bpm: 120, timebase: 'shared' });
  const leader = new NcSyncPeer({
    app: 'Example Drums', version: '0.2.0', clock: leaderClock, channel: h.channel(), locks: null, now: () => now.t,
    heartbeatMs: 60_000, joinGraceMs: 0, instanceId: 'drums', swing: () => swing,
    capabilities: { prefersLeader: true, swing: true, sampleAccurate: true },
  });
  const followerClock = new NcClock({ bpm: 120, timebase: 'shared' });
  const follower = new NcSyncPeer({
    app: 'Example Metronome', version: '0.2.0', clock: followerClock, channel: h.channel(), locks: null, now: () => now.t,
    heartbeatMs: 60_000, joinGraceMs: 0, instanceId: 'metro',
  });
  const heard: number[] = [];
  follower.onSwing(value => heard.push(value));
  try {
    assert.equal(follower.swing, null, 'no swing until a leader sets one');
    await leader.start(); await follower.start(); await flush();
    assert.equal(leader.isLeader, true);
    assert.equal(follower.swing, 0.5);
    swing = 0.66;
    assert.equal(leader.publishState(), true); await flush();
    assert.equal(follower.swing, 0.66);
    assert.deepEqual(heard, [0.5, 0.66]);
    const state = h.log.filter(m => m.type === 'state' && m.from === 'drums');
    assert.equal((state[state.length - 1] as { swing?: number } | undefined)?.swing, 0.66);
    assert.equal(followerClock.transport.timeAt(8), leaderClock.transport.timeAt(8));
  } finally { leader.stop(); follower.stop(); }
});

test('swing back-compat: an old leader (always swing 0) or a bad value never changes the session swing', async () => {
  const h = hub(), now = { t: 2000 };
  const { clock, peer } = makePeer(h, 'listener', now);
  const heard: number[] = [];
  peer.onSwing(v => heard.push(v));
  const old = h.channel(); // speaks raw NC Sync like nc-clock 0.1.0
  try {
    await peer.start(); await flush();
    const snap = (stoppedBeat: number) => ({ ...new NcClock({ bpm: 90, timebase: 'shared' }).toSnapshot(), stoppedBeat });
    const state = (seq: number, swing: unknown, stoppedBeat: number) => old.postMessage(envelope({ type: 'state', clock: snap(stoppedBeat), swing, leaderApp: 'Old App' } as never, 'old', 5, seq, now.t));
    state(1, 0, 1); await flush();
    assert.equal(clock.transport.bpm, 90, 'the clock part of the state still applies');
    assert.equal(peer.swing, null, '0 is "unset", not a swing amount');
    state(2, 0.6, 2); await flush();
    assert.equal(peer.swing, 0.6);
    for (const [seq, bad] of [[3, 0], [4, 0.9], [5, 0.2], [6, Number.NaN], [7, '0.7'], [8, null]] as const) state(seq, bad, seq);
    await flush();
    assert.equal(clock.transport.stoppedBeat, 8, 'every state was applied');
    assert.equal(peer.swing, 0.6, 'unset and invalid values leave the last swing alone');
    assert.deepEqual(heard, [0.6]);
  } finally { peer.stop(); old.close(); }
});

test('swing on the wire: a leader clamps its own value and sends 0 when it has no swing', async () => {
  const h = hub(), now = { t: 3000 };
  let own: number | null = 0.9;
  const clock = new NcClock({ bpm: 120, timebase: 'shared' });
  const leader = new NcSyncPeer({ app: 'Lead', version: '0', clock, channel: h.channel(), locks: null, now: () => now.t,
    heartbeatMs: 60_000, joinGraceMs: 0, instanceId: 'lead', swing: () => own, capabilities: { prefersLeader: true, swing: true } });
  const plain = makePeer(h, 'plain', now);
  try {
    await leader.start(); await plain.peer.start(); await flush();
    const last = () => h.log.filter(m => m.type === 'state' && m.from === 'lead').at(-1) as { swing: number; clock: object };
    assert.equal(last().swing, 0.75, 'clamped to the v1 range');
    own = 0.2; leader.publishState(); await flush();
    assert.equal(last().swing, 0.5);
    own = null; leader.publishState(); await flush();
    assert.equal(last().swing, 0, 'unset');
    assert.equal(plain.peer.swing, 0.5, 'followers keep the last real swing');
    assert.ok(!('swing' in last().clock), 'swing is not part of the clock snapshot');
    // A peer without a swing option sends "unset" when it leads.
    leader.stop(); await flush();
    assert.equal(plain.peer.isLeader, true);
    assert.equal((h.log.filter(m => m.type === 'state' && m.from === 'plain').at(-1) as { swing: number }).swing, 0);
  } finally { leader.stop(); plain.peer.stop(); }
});

test('swing is loop-safe: handlers that republish do not echo, followers cannot publish', async () => {
  const h = hub(), now = { t: 4000 };
  let swing = 0.55;
  const clock = new NcClock({ bpm: 120, timebase: 'shared' });
  const leader = new NcSyncPeer({ app: 'Lead', version: '0', clock, channel: h.channel(), locks: null, now: () => now.t,
    heartbeatMs: 60_000, joinGraceMs: 0, instanceId: 'lead', swing: () => swing, capabilities: { prefersLeader: true, swing: true } });
  const f = makePeer(h, 'follow', now);
  // Naive apps: adopt the swing and "publish" it back.
  leader.onSwing(v => { swing = v; leader.publishState(); });
  let followerPublished = 0;
  f.peer.onSwing(() => { if (f.peer.publishState()) followerPublished++; });
  try {
    await leader.start(); await f.peer.start(); await flush();
    const states = () => h.log.filter(m => m.type === 'state').length;
    const before = states();
    swing = 0.7; leader.publishState(); await flush(40);
    assert.equal(states() - before, 2, 'the edit plus one republish from the handler, then quiet');
    assert.equal(f.peer.swing, 0.7);
    assert.equal(followerPublished, 0);
    assert.ok(!h.log.some(m => m.type === 'state' && m.from === 'follow'), 'a follower never sends state');
  } finally { leader.stop(); f.peer.stop(); }
});

test('a peer that vanishes without bye (tab closed) leaves no sequence entry behind once it times out; stop() clears them', async () => {
  // Found in ASTRID's multi-tab crash soak (NetComposer-Synth fix/crash-soak 7ea28c8): one lastSeq entry (~100 B)
  // stayed for every tab closed without bye, for the life of the page. The 0.3.0 pre-release (b753634) leaves 25 here.
  const h = hub(), now = { t: 1000 };
  const a = makePeer(h, 'synth', now);
  await a.peer.start(); await flush();
  const internal = a.peer as unknown as { lastSeq: Map<string, number>; beat(): void };
  for (let i = 0; i < 25; i++) {
    const gone = makePeer(h, `drums-${i}`, now, { prefersLeader: true });
    await gone.peer.start(); await flush();
    assert.equal(a.peer.peers.has(`drums-${i}`), true);
    const g = gone.peer as unknown as { channel: ChannelLike };
    g.channel.close(); // closed tab: no bye reaches anyone
    g.channel = { postMessage() {}, onmessage: null, close() {} };
    gone.peer.stop(); // only clears its timers now
    now.t += 4; internal.beat(); await flush();
    assert.equal(a.peer.peers.size, 0, 'timed out');
  }
  assert.equal(internal.lastSeq.size, 0, `${internal.lastSeq.size} sequence entries kept for departed peers`);
  const b = makePeer(h, 'bass', now);
  await b.peer.start(); await flush();
  assert.ok(internal.lastSeq.size > 0, 'a live peer has an entry');
  a.peer.stop();
  assert.equal(internal.lastSeq.size, 0, 'stop() clears them');
  b.peer.stop();
});
