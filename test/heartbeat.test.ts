import test from 'node:test';
import assert from 'node:assert/strict';
import { NcClock } from '../src/core/index.js';
import { NcSyncPeer, type ChannelLike } from '../src/peer.js';
import type { NcSyncMessage } from '../src/protocol.js';

// A peer beats only while it knows another peer: alone nobody listens, and an idle page must not wake every
// heartbeatMs. A newcomer still learns about everyone, since every peer answers its `hello` with a heartbeat.

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
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const HEARTBEAT_MS = 10;
function peer(h: ReturnType<typeof hub>, app: string, now: () => number, channel = h.channel()) {
  return new NcSyncPeer({ app, version: '0.0.0', clock: new NcClock({ bpm: 120, timebase: 'shared' }), channel, locks: null, now,
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
