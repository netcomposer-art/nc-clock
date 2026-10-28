import test from 'node:test';
import assert from 'node:assert/strict';
import { NcClock } from '../src/core/index.js';
import { NcSyncPeer, type ChannelLike } from '../src/peer.js';
import { ANY_SLOT, cancelsRecall, envelope, parseMessage, type NcSyncMessage, type SnapshotMessage } from '../src/protocol.js';
import { NcSyncPeer as NcSyncPeer030 } from './fixtures/nc-clock-f509605/peer.js';
import { parseMessage as parseMessage030 } from './fixtures/nc-clock-f509605/protocol.js';

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
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

function makePeer(h: ReturnType<typeof hub>, app: string, now: { t: number }, prefersLeader = false) {
  const clock = new NcClock({ bpm: 120, timebase: 'shared' });
  const peer = new NcSyncPeer({ app, version: '0.0.0', clock, channel: h.channel(), locks: null, now: () => now.t,
    heartbeatMs: 60_000, joinGraceMs: 0, capabilities: { prefersLeader }, instanceId: app });
  return { clock, peer };
}

/**
 * A follower's slot queue as an app would keep it (Rhythm's SlotQueue in miniature): one held recall, replaced by a
 * newer recall, dropped by a matching cancel, taken when its beat comes round.
 */
function follower(peer: NcSyncPeer) {
  const s = { slot: 0, held: null as SnapshotMessage | null, switches: [] as number[] };
  peer.onSnapshot(m => {
    if (m.op === 'recall') s.held = m;
    else if (m.op === 'cancel' && s.held && cancelsRecall(m, s.held)) s.held = null;
  });
  return Object.assign(s, {
    /** The scheduler reaches `beat`: take the held recall if it is due. */
    due(beat: number) { if (s.held && beat >= (s.held.atBeat ?? 0)) { s.slot = s.held.slot; s.switches.push(s.held.slot); s.held = null; } },
  });
}

async function session(t: { after(fn: () => void): void }) {
  const h = hub(), now = { t: 1000 };
  const lead = makePeer(h, 'drums', now, true); await lead.peer.start();
  const fol = makePeer(h, 'synth', now); await fol.peer.start(); await flush();
  assert.equal(lead.peer.isLeader, true); assert.equal(fol.peer.isLeader, false);
  t.after(() => { lead.peer.stop(); fol.peer.stop(); }); // also on a failed assertion, so a failure can't hang the run
  return { h, lead, fol, f: follower(fol.peer) };
}

const snap = (body: Partial<SnapshotMessage>, from = 'a', seq = 1) =>
  envelope({ type: 'snapshot', op: 'recall', slot: 0, ...body } as never, from, 1, seq, 0) as SnapshotMessage;

// ---- encoding ---------------------------------------------------------------------------------

test('cancel: encoding — sendCancel sends op "cancel" with ANY_SLOT, or a slot and recallSeq; sendSnapshot returns its seq', async t => {
  const s = await session(t);
  const seq = s.lead.peer.sendSnapshot('recall', 2, { atBeat: 8 });
  assert.ok(seq > 0, 'sendSnapshot returns the seq it sent');
  const c1 = s.lead.peer.sendCancel();
  const c2 = s.lead.peer.sendCancel({ slot: 2, recallSeq: seq });
  assert.equal(c1, seq + 1); assert.equal(c2, seq + 2);
  const sent = s.h.log.filter((m): m is SnapshotMessage => m.type === 'snapshot');
  assert.deepEqual(sent.map(m => [m.op, m.slot, m.seq, m.recallSeq]), [['recall', 2, seq, undefined], ['cancel', ANY_SLOT, c1, undefined], ['cancel', 2, c2, seq]]);
  assert.equal('recallSeq' in sent[1], false, 'no recallSeq field unless given');
  for (const m of sent) assert.deepEqual(parseMessage(m), m, 'round-trips through the validator');
});

test('cancel: validator accepts cancel; rejects bad recallSeq, bad slots and unknown ops', () => {
  assert.ok(parseMessage(snap({ op: 'cancel', slot: ANY_SLOT }, 'a', 2)));
  assert.ok(parseMessage(snap({ op: 'cancel', slot: 3, recallSeq: 7 }, 'a', 8)));
  const bad: [string, Record<string, unknown>][] = [
    ['non-numeric recallSeq', { op: 'cancel', slot: ANY_SLOT, recallSeq: 'x' }],
    ['null recallSeq', { op: 'cancel', slot: ANY_SLOT, recallSeq: null }],
    ['fractional recallSeq', { op: 'cancel', slot: ANY_SLOT, recallSeq: 5.5 }],
    ['recallSeq 0', { op: 'cancel', slot: ANY_SLOT, recallSeq: 0 }],
    ['negative recallSeq', { op: 'cancel', slot: ANY_SLOT, recallSeq: -3 }],
    ['recallSeq = own seq', { op: 'cancel', slot: ANY_SLOT, recallSeq: 8 }],
    ['recallSeq beyond own seq', { op: 'cancel', slot: ANY_SLOT, recallSeq: 999 }],
    ['missing slot', { op: 'cancel', slot: undefined }],
    ['fractional cancel slot', { op: 'cancel', slot: 1.5 }],
    ['cancel slot -2', { op: 'cancel', slot: -2 }],
    ['recall slot -1', { op: 'recall', slot: -1 }],
    ['recall slot 2.5', { op: 'recall', slot: 2.5 }],
    ['unknown op', { op: 'shuffle', slot: 1 }],
  ];
  for (const [why, body] of bad) assert.equal(parseMessage({ ...snap({}, 'a', 8), ...body }), null, why);
  assert.ok(parseMessage(snap({ op: 'recall', slot: 1, recallSeq: 3 } as never, 'a', 8)), 'recallSeq on a recall is an ignored field');
});

test('cancel: sender misuse throws — cancel or recallSeq through sendSnapshot, bad slots or recallSeq in sendCancel', async t => {
  const s = await session(t);
  const p = s.lead.peer as unknown as { sendSnapshot(op: string, slot: number, extra?: object): number };
  assert.throws(() => p.sendSnapshot('cancel', 2), TypeError);
  assert.throws(() => p.sendSnapshot('recall', 2, { recallSeq: 1 }), TypeError);
  assert.throws(() => p.sendSnapshot('recall', -1), TypeError);
  assert.throws(() => p.sendSnapshot('recall', 1.5), TypeError);
  const seq = s.lead.peer.sendSnapshot('recall', 2, { atBeat: 4 });
  assert.throws(() => s.lead.peer.sendCancel({ slot: -2 }), TypeError);
  assert.throws(() => s.lead.peer.sendCancel({ slot: 0.5 }), TypeError);
  assert.throws(() => s.lead.peer.sendCancel({ recallSeq: seq + 1 }), TypeError, 'not sent yet');
  assert.throws(() => s.lead.peer.sendCancel({ recallSeq: 1.5 }), TypeError);
  const before = s.h.log.length;
  assert.equal(s.lead.peer.sendCancel({ recallSeq: 0 }), 0, 'recallSeq 0: the recall was never sent, nothing to withdraw');
  assert.equal(s.h.log.length, before, 'nothing sent by a rejected or empty cancel');
});

test('cancel: before start() sendSnapshot and sendCancel send nothing and return 0', () => {
  const p = new NcSyncPeer({ app: 'x', version: '0', clock: new NcClock({ bpm: 120 }), channel: hub().channel(), locks: null, instanceId: 'x' });
  assert.equal(p.sendSnapshot('recall', 1), 0);
  assert.equal(p.sendCancel(), 0);
  assert.equal(p.sendCancel({ recallSeq: 0 }), 0);
});

// ---- matching rule ----------------------------------------------------------------------------

test('cancelsRecall: same sender, later seq, slot match or ANY_SLOT, recallSeq at or after the recall', () => {
  const r = snap({ op: 'recall', slot: 2, atBeat: 8 }, 'a', 5);
  assert.equal(cancelsRecall(snap({ op: 'cancel', slot: ANY_SLOT }, 'a', 6), r), true, 'any slot');
  assert.equal(cancelsRecall(snap({ op: 'cancel', slot: 2 }, 'a', 6), r), true, 'same slot');
  assert.equal(cancelsRecall(snap({ op: 'cancel', slot: 3 }, 'a', 6), r), false, 'other slot');
  assert.equal(cancelsRecall(snap({ op: 'cancel', slot: ANY_SLOT, recallSeq: 5 }, 'a', 6), r), true, 'names this recall');
  assert.equal(cancelsRecall(snap({ op: 'cancel', slot: ANY_SLOT, recallSeq: 4 }, 'a', 6), r), false, 'stale: names an older recall');
  assert.equal(cancelsRecall(snap({ op: 'cancel', slot: ANY_SLOT }, 'b', 6), r), false, 'another sender');
  assert.equal(cancelsRecall(snap({ op: 'cancel', slot: ANY_SLOT }, 'a', 4), r), false, 'sent before the recall');
  assert.equal(cancelsRecall(snap({ op: 'recall', slot: 2 }, 'a', 6), r), false, 'not a cancel');
  assert.equal(cancelsRecall(snap({ op: 'cancel', slot: ANY_SLOT }, 'a', 6), snap({ op: 'store', slot: 2 }, 'a', 5)), false, 'not a recall');
  assert.equal(cancelsRecall(snap({ op: 'cancel', slot: ANY_SLOT, recallSeq: 6 }, 'a', 6), r), false, 'recallSeq not below its own seq');
  assert.equal(cancelsRecall(snap({ op: 'cancel', slot: ANY_SLOT }, 'a', 6), snap({ op: 'recall', slot: 2 }, 'a', 5)), true, 'a recall without atBeat (held to the next bar) too');
});

// ---- two peers --------------------------------------------------------------------------------

test('two peers, control: a recall without a cancel switches the follower on the bar line', async t => {
  const s = await session(t);
  s.lead.peer.sendSnapshot('recall', 2, { atBeat: 4 }); await flush();
  s.f.due(3.75); assert.equal(s.f.slot, 0, 'not yet');
  s.f.due(4); assert.equal(s.f.slot, 2); assert.deepEqual(s.f.switches, [2]);
});

test('two peers, leader Load: recall then cancel(recallSeq) — the follower does NOT switch', async t => {
  const s = await session(t);
  const seq = s.lead.peer.sendSnapshot('recall', 2, { atBeat: 4 }); await flush();
  assert.equal(s.f.held?.slot, 2, 'held');
  s.lead.peer.sendCancel({ slot: 2, recallSeq: seq }); await flush(); // Load cancels the queued slot
  s.f.due(4); s.f.due(8);
  assert.equal(s.f.slot, 0); assert.deepEqual(s.f.switches, []);
});

test('two peers, leader New: recall then a bare cancel() — the follower does NOT switch', async t => {
  const s = await session(t);
  s.lead.peer.sendSnapshot('recall', 5, { atBeat: 4 });
  s.lead.peer.sendCancel(); await flush(); // same task: ordering by seq still holds
  s.f.due(4);
  assert.equal(s.f.slot, 0); assert.deepEqual(s.f.switches, []);
});

test('two peers, stale cancel: a cancel naming an older recall leaves the newer one, which switches', async t => {
  const s = await session(t);
  const a = s.lead.peer.sendSnapshot('recall', 1, { atBeat: 4 });
  s.lead.peer.sendSnapshot('recall', 3, { atBeat: 4 }); // replaces the held recall
  s.lead.peer.sendCancel({ recallSeq: a }); await flush();
  s.f.due(4);
  assert.equal(s.f.slot, 3); assert.deepEqual(s.f.switches, [3]);
});

test('two peers, late cancel: arriving after the bar line was taken it is a no-op', async t => {
  const s = await session(t);
  const seq = s.lead.peer.sendSnapshot('recall', 2, { atBeat: 4 }); await flush();
  s.f.due(4); assert.equal(s.f.slot, 2);
  s.lead.peer.sendCancel({ recallSeq: seq }); await flush();
  s.f.due(8);
  assert.equal(s.f.slot, 2, 'stays on the slot it took'); assert.deepEqual(s.f.switches, [2]);
});

test('two peers, a cancel then a new recall: the new recall still switches; a recall from another peer is not cancelled', async t => {
  const s = await session(t);
  s.lead.peer.sendSnapshot('recall', 2, { atBeat: 4 });
  s.lead.peer.sendCancel();
  s.lead.peer.sendSnapshot('recall', 6, { atBeat: 8 }); await flush();
  s.f.due(4); assert.equal(s.f.slot, 0);
  s.f.due(8); assert.equal(s.f.slot, 6);
  // A cancel only withdraws its sender's own recall.
  const other = snap({ op: 'recall', slot: 7, atBeat: 12 }, 'someone-else', 1);
  s.f.held = other;
  (s.fol.peer as unknown as { receive(d: unknown): void }).receive(snap({ op: 'cancel', slot: ANY_SLOT }, 'drums', 999));
  assert.equal(s.f.held, other);
});

// ---- hand-delivered channel: reordering, duplicates, leader change, restarts, a real 0.3.0 receiver ----------------

/** A channel whose messages wait in each member's inbox until the test delivers them, in any order, any number of times. */
function manualHub() {
  const members = new Map<ChannelLike, unknown[]>();
  return {
    channel(): ChannelLike {
      const ch: ChannelLike = { onmessage: null, postMessage(d: unknown) { const c = JSON.parse(JSON.stringify(d)); for (const [m, box] of members) if (m !== ch) box.push(c); }, close() { members.delete(ch); } };
      members.set(ch, []);
      return ch;
    },
    inbox(ch: ChannelLike) { return members.get(ch)!; },
    deliver(ch: ChannelLike, msgs: unknown[]) { for (const d of msgs) ch.onmessage?.({ data: d }); },
    drainAll() { for (let k = 0; k < 10; k++) { let any = false; for (const [ch, box] of members) if (box.length) { any = true; this.deliver(ch, box.splice(0)); } if (!any) break; } },
  };
}
type AnyPeerClass = typeof NcSyncPeer | typeof NcSyncPeer030;
const tick = () => new Promise(r => setTimeout(r, 5));
function manualPeer(Cls: AnyPeerClass, h: ReturnType<typeof manualHub>, app: string, now: { t: number }, prefersLeader = false) {
  const ch = h.channel();
  const peer = new Cls({ app, version: '0', clock: new NcClock({ bpm: 120, timebase: 'shared' }), channel: ch, locks: null,
    now: () => now.t, heartbeatMs: 3_600_000, joinGraceMs: 0, capabilities: { prefersLeader }, instanceId: app }) as NcSyncPeer;
  return { ch, peer };
}
async function settle(h: ReturnType<typeof manualHub>) { for (let i = 0; i < 3; i++) { await tick(); h.drainAll(); } }
/** Leader (this version) and a follower built from `Cls`, both started and settled. */
async function manualPair(t: { after(fn: () => void): void }, Cls: AnyPeerClass = NcSyncPeer) {
  const h = manualHub(), now = { t: 1000 };
  const L = manualPeer(NcSyncPeer, h, 'lead', now, true), F = manualPeer(Cls, h, 'fol', now);
  await L.peer.start(); await F.peer.start(); await settle(h);
  t.after(() => { L.peer.stop(); F.peer.stop(); });
  return { h, now, L, F, f: follower(F.peer) };
}

test('reordered: a cancel delivered before its recall still wins (the late recall is dropped by seq dedupe)', async t => {
  const s = await manualPair(t); const box = s.h.inbox(s.F.ch); box.length = 0;
  const rs = s.L.peer.sendSnapshot('recall', 2, { atBeat: 4 }); s.L.peer.sendCancel({ slot: 2, recallSeq: rs });
  const [rec, can] = box.splice(0);
  s.h.deliver(s.F.ch, [can, rec]); s.f.due(4);
  assert.deepEqual(s.f.switches, []); assert.equal(s.f.held, null);
});

test('duplicates: recall and cancel delivered several times are each applied once; no switch', async t => {
  const s = await manualPair(t); const box = s.h.inbox(s.F.ch); box.length = 0;
  const seen: string[] = []; s.F.peer.onSnapshot(m => seen.push(`${m.op}#${m.seq}`));
  const rs = s.L.peer.sendSnapshot('recall', 2, { atBeat: 4 }); s.L.peer.sendCancel({ recallSeq: rs });
  const [rec, can] = box.splice(0);
  s.h.deliver(s.F.ch, [rec, rec, can, can, rec]); s.f.due(4);
  assert.deepEqual(seen, [`recall#${rs}`, `cancel#${rs + 1}`]); assert.deepEqual(s.f.switches, []);
});

test('leader change between recall and cancel: the ex-leader\'s cancel still withdraws its own recall (matched on from, not term)', async t => {
  const h = manualHub(), now = { t: 1000 };
  const L = manualPeer(NcSyncPeer, h, 'm-old', now), F = manualPeer(NcSyncPeer, h, 'z-fol', now);
  await L.peer.start(); await F.peer.start(); await settle(h);
  const f = follower(F.peer);
  assert.equal(L.peer.isLeader, true);
  const rs = L.peer.sendSnapshot('recall', 3, { atBeat: 8 }); h.drainAll();
  const N = manualPeer(NcSyncPeer, h, 'a-new', now, true); await N.peer.start(); await settle(h);
  t.after(() => { L.peer.stop(); F.peer.stop(); N.peer.stop(); });
  assert.deepEqual([L.peer.isLeader, N.peer.isLeader], [false, true], 'the lead moved to the newcomer');
  L.peer.sendCancel({ slot: 3, recallSeq: rs }); h.drainAll(); f.due(8);
  assert.deepEqual(f.switches, []);
});

test('sender stop()/start() on the same object keeps seq counting, so its cancel still matches', async t => {
  const s = await manualPair(t);
  const rs = s.L.peer.sendSnapshot('recall', 2, { atBeat: 4 }); s.h.drainAll();
  s.L.peer.stop(); s.h.drainAll(); await s.L.peer.start(); await settle(s.h);
  const cs = s.L.peer.sendCancel({ recallSeq: rs }); s.h.drainAll(); s.f.due(4);
  assert.ok(cs > rs); assert.deepEqual(s.f.switches, []);
});

test('pinned instanceId reused by a new peer object (documented hazard): seq restarts, the cancel is dropped as a repeat', async t => {
  const s = await manualPair(t);
  s.L.peer.sendSnapshot('recall', 2, { atBeat: 4 }); s.L.peer.sendSnapshot('recall', 2, { atBeat: 4 }); s.h.drainAll();
  const L2 = manualPeer(NcSyncPeer, s.h, 'lead', s.now); await L2.peer.start(); s.h.drainAll();
  t.after(() => L2.peer.stop());
  L2.peer.sendCancel(); s.h.drainAll(); s.f.due(4);
  assert.deepEqual(s.f.switches, [2], 'why the instanceId option says never to reuse a pinned id');
});

test('sender leaves (bye) with a recall held: no implicit cancel, the receiver keeps it (spec: kept)', async t => {
  const s = await manualPair(t);
  s.L.peer.sendSnapshot('recall', 2, { atBeat: 4 }); s.h.drainAll();
  s.L.peer.stop(); s.h.drainAll(); s.f.due(4);
  assert.deepEqual(s.f.switches, [2]);
});

test('a real nc-clock 0.3.0 (f509605) receiver drops cancel: listeners never see it, later recalls still arrive, it still switches', async t => {
  assert.equal(parseMessage030(snap({ op: 'cancel', slot: ANY_SLOT, recallSeq: 1 }, 'a', 2)), null);
  assert.ok(parseMessage030(snap({ op: 'recall', slot: 2 }, 'a', 2)), 'control');
  const s = await manualPair(t, NcSyncPeer030);
  const seen: string[] = [], all: string[] = [];
  s.F.peer.onSnapshot(m => seen.push(`${m.op}#${m.seq}`));
  s.F.peer.onMessage(m => { if (m.type === 'snapshot') all.push(`${m.op}#${m.seq}`); });
  const rs = s.L.peer.sendSnapshot('recall', 2, { atBeat: 4 }); s.L.peer.sendCancel({ slot: 2, recallSeq: rs }); s.h.drainAll();
  s.f.due(4);
  assert.deepEqual(s.f.switches, [2], 'old behaviour: the bar line still switches');
  const r2 = s.L.peer.sendSnapshot('recall', 4, { atBeat: 8 }); s.h.drainAll();
  assert.deepEqual(seen, [`recall#${rs}`, `recall#${r2}`]); assert.deepEqual(all, seen);
});
