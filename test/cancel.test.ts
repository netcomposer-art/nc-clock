import test from 'node:test';
import assert from 'node:assert/strict';
import { NcClock } from '../src/core/index.js';
import { NcSyncPeer, type ChannelLike } from '../src/peer.js';
import { ANY_SLOT, cancelsRecall, envelope, parseMessage, type NcSyncMessage, type SnapshotMessage } from '../src/protocol.js';

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

test('cancel: validator accepts cancel, rejects a non-numeric recallSeq or a missing slot', () => {
  assert.ok(parseMessage(snap({ op: 'cancel', slot: ANY_SLOT })));
  assert.ok(parseMessage(snap({ op: 'cancel', slot: 3, recallSeq: 7 })));
  assert.equal(parseMessage({ ...snap({ op: 'cancel' }), recallSeq: 'x' }), null);
  assert.equal(parseMessage({ ...snap({ op: 'cancel' }), slot: undefined }), null);
  assert.equal(parseMessage(snap({ op: 'shuffle' as never })), null, 'other unknown ops are still dropped');
});

test('cancel: receivers from nc-clock 0.3.0 drop it (unknown op), so it is safe to send to older peers', () => {
  // The 0.3.0 snapshot check, verbatim from src/protocol.ts at f509605.
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const v030 = (m: Record<string, unknown>) => (m.op === 'recall' || m.op === 'stopSequence' || m.op === 'store') && num(m.slot);
  assert.equal(v030(snap({ op: 'cancel', slot: ANY_SLOT }) as never), false);
  assert.equal(v030(snap({ op: 'cancel', slot: 2, recallSeq: 4 }) as never), false);
  assert.equal(v030(snap({ op: 'recall', slot: 2 }) as never), true, 'control');
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
