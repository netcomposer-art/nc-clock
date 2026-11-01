// The start gate (NcSyncPeer `startGate`, AudioClockMapper `whenSettled`): a first Play waits for the audio, on the
// leader for its own Play and a follower's request alike, then lands bar 1 with the gated lead; a Stop cancels it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NcClock } from '../src/core/index.js';
import { NcSyncPeer, type ChannelLike } from '../src/peer.js';
import { AudioClockMapper } from '../src/audio-mapper.js';

function hub() {
  const members = new Set<ChannelLike>();
  return {
    channel(): ChannelLike {
      const ch: ChannelLike = {
        onmessage: null,
        postMessage(data: unknown) { const copy = JSON.parse(JSON.stringify(data)); for (const m of members) if (m !== ch) queueMicrotask(() => m.onmessage?.({ data: copy })); },
        close() { members.delete(ch); },
      };
      members.add(ch);
      return ch;
    },
  };
}
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

/** A gate the test opens by hand; `open` is null once it is ready (no wait). */
function gate() {
  let release: (() => void) | null = null;
  const g = {
    ready: false,
    calls: 0,
    fn: (): Promise<void> | null => {
      g.calls++;
      if (g.ready) return null;
      return new Promise<void>(r => { release = r; });
    },
    open() { g.ready = true; release?.(); },
  };
  return g;
}

function peerWith(h: ReturnType<typeof hub>, app: string, now: { t: number }, prefersLeader: boolean, startGate?: () => PromiseLike<unknown> | null) {
  const clock = new NcClock({ bpm: 120, timebase: 'shared' });
  const peer = new NcSyncPeer({ app, version: '0.0.0', clock, channel: h.channel(), locks: null, now: () => now.t,
    heartbeatMs: 60_000, joinGraceMs: 0, capabilities: { prefersLeader }, instanceId: app, ...(startGate ? { startGate } : {}) });
  return { clock, peer };
}

test('start gate: a leader Play waits, then lands bar 1 the gated lead after the press', async () => {
  const h = hub(), now = { t: 1000 }, g = gate();
  const r = peerWith(h, 'studio', now, true, g.fn); await r.peer.start(); await flush();
  r.clock.play({ at: now.t });
  await flush();
  assert.equal(r.clock.transport.running, false, 'not committed while the gate is shut');
  now.t += 0.05; // the audio is ready 50 ms after the press
  g.open(); await flush();
  assert.equal(r.clock.transport.running, true);
  assert.ok(Math.abs(r.clock.transport.startTime! - 1000.3) < 1e-9, 'press + 0.3 s');
  // A gate that took long: the usual lead from when it opened, not a bar 1 in the past.
  r.clock.stop({ at: now.t }); await flush();
  const late = gate(); const r2 = peerWith(hub(), 'studio2', now, true, late.fn); await r2.peer.start(); await flush();
  r2.clock.play({ at: now.t }); now.t += 0.9; late.open(); await flush();
  assert.ok(Math.abs(r2.clock.transport.startTime! - (now.t + 0.2)) < 1e-9, 'opened 0.9 s later: now + 0.2 s');
  r.peer.stop(); r2.peer.stop();
});

test('start gate: a follower request waits on the leader gate; a ready gate starts at once as before', async () => {
  const h = hub(), now = { t: 2000 }, g = gate();
  const r = peerWith(h, 'studio', now, true, g.fn); await r.peer.start();
  const a = peerWith(h, 'rhythm', now, false); await a.peer.start(); await flush();
  a.clock.play({ at: now.t }); await flush();
  assert.equal(r.clock.transport.running, false, 'the leader waits for its audio');
  now.t += 0.1; g.open(); await flush();
  assert.ok(Math.abs(r.clock.transport.startTime! - 2000.3) < 1e-9, 'gated lead from the request');
  assert.equal(a.clock.transport.startTime, r.clock.transport.startTime);
  // Stop, then Play again: the gate is ready now, so the usual lead.
  a.clock.stop({ at: now.t }); await flush();
  now.t += 1;
  a.clock.play({ at: now.t }); await flush();
  assert.ok(Math.abs(r.clock.transport.startTime! - (now.t + 0.2)) < 1e-9, 'ready: now + 0.2 s');
  a.peer.stop(); r.peer.stop();
});

test('start gate: a Stop while waiting cancels the start; a running transport is never gated', async () => {
  const h = hub(), now = { t: 3000 }, g = gate();
  const r = peerWith(h, 'solo', now, true, g.fn); await r.peer.start(); await flush();
  r.clock.play({ at: now.t }); await flush();
  r.clock.stop({ at: now.t }); await flush();
  g.open(); await flush();
  assert.equal(r.clock.transport.running, false, 'the stop cancelled the waiting start');
  // A follower's own gate holds its request until its audio is ready.
  const fg = gate();
  const a = peerWith(h, 'follower', now, false, fg.fn); await a.peer.start(); await flush();
  a.clock.play({ at: now.t }); await flush();
  assert.equal(r.clock.transport.running, false, 'not sent while the follower waits');
  fg.open(); await flush();
  assert.equal(r.clock.transport.running, true, 'sent once ready');
  const calls = g.calls;
  now.t += 1;
  a.clock.play({ at: now.t }); await flush();
  assert.equal(g.calls, calls, 'restart while running: no gate');
  a.peer.stop(); r.peer.stop();
});

test('whenSettled: null when settled; else waits for the stamp to agree, or gives up', async () => {
  const ORIGIN = 1_700_000_000_000;
  const d = {
    perf: 1000, state: 'suspended', skew: 0,
    get currentTime() { return d.perf / 1000 + 5; },
    outputLatency: 0, baseLatency: 0,
    getOutputTimestamp: () => ({ contextTime: d.currentTime + d.skew, performanceTime: d.perf }),
  };
  const m = new AudioClockMapper(d, { timeOrigin: ORIGIN, perfNow: () => d.perf, warmIntervalMs: 0 });
  assert.equal(m.settledNow(), false, 'suspended');
  const waiting = m.whenSettled(50);
  assert.ok(waiting, 'a wait');
  d.state = 'running';
  for (let i = 0; i < 4; i++) { d.perf += 3; m.sample(); }
  assert.equal(await waiting, true);
  assert.equal(m.whenSettled(), null, 'settled: no wait');
  // A reading 10 ms off after ready: not settled until it agrees again.
  d.skew = 0.01; d.perf += 3;
  assert.equal(m.settledNow(), false);
  const late = m.whenSettled(20)!;
  const giveUp = setInterval(() => { d.perf += 5; }, 1);
  assert.equal(await late, false, 'gives up after timeoutMs');
  clearInterval(giveUp);
  d.skew = 0; d.perf += 3;
  assert.equal(m.settledNow(), true);
});
