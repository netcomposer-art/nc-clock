// One "instrument" tab for the three-tab independent-stop e2e (test/e2e/three-tab.mjs). It schedules a beat on every
// whole beat while clock.isPlayingAt(), from the shared clock only, and exposes the window.ncE2E hook the harness
// drives. `?legacy` plays an older (0.4.0-style) peer without independentStop, for the mixed-session step. With `?audio`, every beat is also a real (silent) Web Audio note: an oscillator started at
// AudioClockMapper.toContextTime(beat time), which the harness measures from outside (OscillatorNode.start). Instruments implement the same hook (see test/e2e/three-tab.mjs) to run the harness in their own suites.
import { AudioClockMapper, NcClock, NcSyncPeer, createTicker, sharedNow } from '../../dist/index.js';

const q = new URLSearchParams(location.search);
const app = q.get('app') ?? 'tab';
const clock = new NcClock({ bpm: 120, timebase: 'shared' });
const swing = q.has('swing') ? Number(q.get('swing')) : null;
const peer = new NcSyncPeer({
  app, version: '0.5.0', clock, channel: q.get('channel') ?? 'nc-sync-e2e', instanceId: q.get('id') ?? undefined,
  independentStop: !q.has('legacy'), capabilities: { prefersLeader: q.has('prefersLeader'), swing: swing !== null },
  ...(swing !== null ? { swing: () => swing } : {}),
});

// Real notes: a near-silent click per beat on this tab's own AudioContext, scheduled through the shared-time mapper.
const ctx = q.has('audio') ? new AudioContext() : null;
const mapper = ctx ? new AudioClockMapper(ctx) : null;
const skew = Number(q.get('skewMs') ?? 0) / 1000; // negative control only: play every note this late
const out = ctx ? new GainNode(ctx, { gain: 0.0001 }) : null;
if (ctx) { out.connect(ctx.destination); ctx.resume?.(); mapper.start(); }
const note = (beat, time) => {
  if (!ctx || ctx.state !== 'running' || !mapper.sampleIfNotReady()) return false;
  const when = mapper.toContextTime(time + skew);
  if (when < ctx.currentTime) return false;
  const osc = new OscillatorNode(ctx, { frequency: 880 });
  osc.connect(out);
  window.__ncE2EBeat = beat; // the harness's OscillatorNode.start probe pairs the note with its beat
  osc.start(when); osc.stop(when + 0.03);
  window.__ncE2EBeat = undefined;
  return true;
};

const LOOKAHEAD = 0.12;
const onsets = [];
let next = null;   // next beat to schedule, or null to (re)join on the next grid line
let runStart = null;
clock.onChange(change => {
  if (change.kind === 'member' || change.kind === 'start') next = null;
  if (change.kind === 'snapshot' && change.snapshot.startTime !== runStart) next = null;
});
const ticker = createTicker(() => {
  const now = sharedNow(), t = clock.transport;
  runStart = t.startTime;
  if (!clock.playing || t.startTime === null) { next = null; return; }
  if (next === null) next = clock.joinPoint(Math.max(now, t.startTime)).beat;
  for (let time = t.timeAt(next); time < now + LOOKAHEAD; time = t.timeAt(++next)) {
    if (clock.isPlayingAt(time) && time >= now - 0.005) onsets.push({ beat: next, time, audio: note(next, time) });
  }
}, { intervalMs: 20 });

const status = document.getElementById('status');
const render = () => {
  const t = clock.transport;
  status.textContent = `${app} ${peer.isLeader ? 'leads' : 'follows'} (term ${peer.term})\n` +
    `this tab: ${clock.playing ? 'playing' : 'stopped'} · session: ${t.running ? 'running' : 'stopped'} · beat ${t.beatAt(sharedNow()).toFixed(2)}\n` +
    `peers: ${[...peer.peers.values()].map(p => `${p.app}${p.leader ? '*' : ''}:${p.playing === null ? '?' : p.playing ? 'on' : 'off'}`).join(' ') || 'none'}`;
};
setInterval(render, 100);
document.getElementById('play').onclick = () => clock.play({ at: sharedNow() });
document.getElementById('stop').onclick = () => clock.stop({ at: sharedNow() });

window.ncE2E = {
  version: 1,
  play() { clock.play({ at: sharedNow() }); },
  stop() { clock.stop({ at: sharedNow() }); },
  state() {
    const s = clock.toSnapshot();
    return { id: peer.id, app, playing: clock.playing, running: clock.transport.running, leader: peer.isLeader, term: peer.term,
      swing: peer.swing, anchor: s.anchor, tempo: s.tempo, startTime: s.startTime, peers: peer.peers.size };
  },
  /** Beats scheduled since the last call: [{ beat, time, audio }] with time in shared seconds (audio: a real note). */
  takeOnsets() { return onsets.splice(0); },
};
await peer.start();
ticker.start();
render();
