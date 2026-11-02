import test from 'node:test';
import assert from 'node:assert/strict';
import { NcClock } from '../src/core/index.js';
import { NcSyncPeer, type ChannelLike, type LocksLike } from '../src/peer.js';
import type { NcSyncMessage } from '../src/protocol.js';

// A peer beats only while it knows another peer: alone nobody listens, and an idle page must not wake every
// heartbeatMs. A newcomer still learns about everyone, since every peer answers its `hello` with a heartbeat.

/** In-memory BroadcastChannel: delivers to every other member, asynchronously, in order. Members in `deaf`
 *  hear nothing (a frozen background tab). */
function hub() {
  const members = new Set<ChannelLike>();
  const deaf = new Set<ChannelLike>();
  const log: NcSyncMessage[] = [];
  return {
    log, deaf,
    channel(): ChannelLike {
      const ch: ChannelLike = {
        onmessage: null,
        postMessage(data: unknown) { const copy = JSON.parse(JSON.stringify(data)); log.push(copy); for (const m of members) if (m !== ch && !deaf.has(m)) queueMicrotask(() => m.onmessage?.({ data: copy })); },
        close() { members.delete(ch); },
      };
      members.add(ch);
      return ch;
    },
  };
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const HEARTBEAT_MS = 10;
function peer(h: ReturnType<typeof hub>, app: string, now: () => number, channel = h.channel(), locks: LocksLike | null = null) {
  return new NcSyncPeer({ app, version: '0.0.0', clock: new NcClock({ bpm: 120, timebase: 'shared' }), channel, locks, now,
    heartbeatMs: HEARTBEAT_MS, joinGraceMs: 0, instanceId: app });
}
const beatsFrom = (h: ReturnType<typeof hub>, id: string) => h.log.filter(m => m.type === 'heartbeat' && m.from === id).length;

test('heartbeat: a lone peer does not beat, beats once a second peer appears, and stops again when it leaves (bye)', async () => {
  const h = hub(), now = () => 1000;
  const a = peer(h, 'a', now), b = peer(h, 'b', now);
  try {
    await a.start(); await wait(2 * HEARTBEAT_MS);
    assert.equal(a.beating, false, 'alone: no heartbeat timer');
    // (Taking the lead announces the role once, with a single heartbeat; that is not the timer.)
    const alone = beatsFrom(h, 'a');
    assert.ok(alone <= 1, `at most the one role announcement (${alone})`);
    await wait(8 * HEARTBEAT_MS);
    assert.equal(beatsFrom(h, 'a'), alone, 'alone: no heartbeat sent on a timer');

    await b.start(); await wait(8 * HEARTBEAT_MS);
    assert.equal(a.beating, true, 'a peer is here: a beats');
    assert.equal(b.beating, true, 'and so does the newcomer');
    assert.ok(beatsFrom(h, 'a') >= 3, `a beats on its timer (${beatsFrom(h, 'a')})`);
    assert.ok(beatsFrom(h, 'b') >= 3, `b beats on its timer (${beatsFrom(h, 'b')})`);

    b.stop(); await wait(2 * HEARTBEAT_MS);
    assert.equal(a.peers.size, 0);
    assert.equal(a.beating, false, 'the last peer left: the timer stops');
    const before = beatsFrom(h, 'a');
    await wait(8 * HEARTBEAT_MS);
    assert.equal(beatsFrom(h, 'a'), before, 'alone again: no heartbeat sent');
    assert.equal(b.beating, false, 'a stopped peer never beats');
  } finally { a.stop(); b.stop(); }
});

test('heartbeat: a lone peer still answers a newcomer\'s hello, so the newcomer learns it at once', async () => {
  const h = hub(), now = () => 1000;
  const a = peer(h, 'a', now), b = peer(h, 'b', now);
  try {
    await a.start(); await wait(2 * HEARTBEAT_MS);
    assert.equal(a.beating, false);
    await b.start(); await wait(1); // well inside one heartbeat period
    assert.deepEqual([...b.peers.keys()], ['a'], 'b knows a from its answer to hello');
    assert.deepEqual([...a.peers.keys()], ['b']);
  } finally { a.stop(); b.stop(); }
});

test('heartbeat: when the other peer vanishes without bye, the timeout drops it and the timer stops', async () => {
  let t = 5000; const now = () => t;
  const h = hub();
  const a = peer(h, 'a', now);
  const bChannel = h.channel();
  const b = peer(h, 'b', now, bChannel);
  try {
    await a.start(); await b.start(); await wait(4 * HEARTBEAT_MS);
    assert.equal(a.beating, true);
    bChannel.onmessage = null; bChannel.postMessage = () => {}; // b's tab crashed: no bye, no more messages
    t += 70_000; // past the hidden-peer timeout too
    await wait(4 * HEARTBEAT_MS);
    assert.equal(a.peers.size, 0, 'b timed out');
    assert.equal(a.beating, false, 'alone again: no heartbeat timer');
  } finally { a.stop(); b.stop(); }
});

/** Web Locks stand-in: one exclusive lock, granted in request order; an aborted waiter leaves the queue. */
function fakeLocks(): LocksLike {
  let held = false; const queue: (() => void)[] = [];
  const next = () => { held = false; queue.shift()?.(); };
  return {
    request(_name, { signal }, callback) {
      return new Promise((resolve, reject) => {
        const run = () => { held = true; callback({}).then(resolve, reject).finally(next); };
        if (!held) { run(); return; }
        queue.push(run);
        signal?.addEventListener('abort', () => { const i = queue.indexOf(run); if (i >= 0) queue.splice(i, 1); reject(new Error('aborted')); });
      });
    },
  };
}

test('heartbeat: under Web Locks a lone tab that missed a newcomer\'s hello finds it when shown again; listeners go on stop', async () => {
  const g = globalThis as { document?: unknown; window?: unknown };
  const saved = { document: g.document, window: g.window };
  const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' as 'hidden' | 'visible' });
  const win = new EventTarget();
  let listening = 0;
  for (const t of [doc, win]) {
    const add = t.addEventListener.bind(t), remove = t.removeEventListener.bind(t);
    t.addEventListener = (type: string, l: EventListenerOrEventListenerObject | null) => { listening++; add(type, l); };
    t.removeEventListener = (type: string, l: EventListenerOrEventListenerObject | null) => { listening--; remove(type, l); };
  }
  g.document = doc; g.window = win;
  const h = hub(), now = () => 1000, locks = fakeLocks();
  const aChannel = h.channel();
  const a = peer(h, 'a', now, aChannel, locks), b = peer(h, 'b', now, h.channel(), locks);
  try {
    await a.start(); await wait(2 * HEARTBEAT_MS);
    assert.equal(a.isLeader, true, 'a holds the lock');
    assert.equal(listening, 2, 'a listens for visibilitychange and pageshow');
    h.deaf.add(aChannel); // a's tab is frozen in the background: it misses b's hello
    await b.start(); await wait(8 * HEARTBEAT_MS);
    h.deaf.delete(aChannel);
    assert.equal(a.peers.size, 0, 'a missed b');
    assert.equal(b.peers.size, 0, 'and b never heard a (a lone peer has no timer)');
    assert.equal(b.isLeader, false, 'b waits for the lock');
    assert.equal(a.beating || b.beating, false, 'neither beats: without the wake guard they would never meet');

    const beforeShow = beatsFrom(h, 'a');
    doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(beatsFrom(h, 'a'), beforeShow + 1, 'shown: one heartbeat');
    await wait(4 * HEARTBEAT_MS);
    assert.deepEqual([...b.peers.keys()], ['a'], 'b hears a');
    assert.deepEqual([...a.peers.keys()], ['b'], 'and a hears b back');
    assert.equal(a.beating && b.beating, true, 'both beat as usual now');

    const beforePageshow = beatsFrom(h, 'b');
    win.dispatchEvent(new Event('pageshow'));
    assert.equal(beatsFrom(h, 'b'), beforePageshow + 1, 'pageshow (back/forward cache): one heartbeat');
    doc.visibilityState = 'hidden'; const beforeHide = beatsFrom(h, 'a');
    doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(beatsFrom(h, 'a'), beforeHide, 'hiding sends nothing extra');

    a.stop(); b.stop();
    assert.equal(listening, 0, 'stop removes every listener');
    const afterStop = h.log.length;
    doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); win.dispatchEvent(new Event('pageshow'));
    assert.equal(h.log.length, afterStop, 'a stopped peer sends nothing on wake');
  } finally { a.stop(); b.stop(); g.document = saved.document; g.window = saved.window; }
});

test('heartbeat: no document or window (Node, workers): start and stop work without wake listeners', async () => {
  const g = globalThis as { document?: unknown; window?: unknown };
  assert.equal(typeof g.document, 'undefined'); assert.equal(typeof g.window, 'undefined');
  const h = hub(), now = () => 1000;
  const a = peer(h, 'a', now, h.channel(), fakeLocks());
  await a.start(); await wait(2 * HEARTBEAT_MS);
  assert.equal(a.isLeader, true);
  a.stop();
  assert.equal(a.beating, false);
});

test('heartbeat: a leader that stops while it holds a stale peer leaves no heartbeat timer behind', async () => {
  // stop() clears the timer, then setLeader(false) beats once; that beat times the stale peer out, and the peer list
  // change used to start the timer again (another peer was still known and the channel was still open). The stopped
  // peer then beat forever, and kept a Node process alive.
  const h = hub();
  let t = 1000; const now = () => t;
  const a = peer(h, 'a', now), fresh = peer(h, 'b', now), stale = peer(h, 'c', now);
  try {
    await a.start(); await wait(2 * HEARTBEAT_MS);
    await fresh.start(); await stale.start(); await wait(4 * HEARTBEAT_MS);
    assert.ok(a.isLeader, 'a leads');
    assert.equal(a.peers.size, 2);
    (stale as unknown as { channel: ChannelLike }).channel = { onmessage: null, postMessage() {}, close() {} }; // goes silent, no bye
    t += 2; await wait(4 * HEARTBEAT_MS);   // a hears b at the new time; c is 2 s old
    t += 1.5;                               // c is now past the 3 s timeout, b is not
    a.stop();
    assert.equal(a.beating, false, 'no heartbeat timer after stop()');
    const sent = beatsFrom(h, 'a');
    await wait(5 * HEARTBEAT_MS);
    assert.equal(beatsFrom(h, 'a'), sent, 'a stopped peer sends no heartbeat');
  } finally { a.stop(); fresh.stop(); stale.stop(); }
});
