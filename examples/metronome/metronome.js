// A minimal NC Sync peer: joins the "nc-sync" channel and ticks a metronome on the shared beat.
// nc-clock was created by Peter Semmelhack (https://psem.me/).
import { NcClock, NcSyncPeer, AudioClockMapper, createTicker, sharedNow, retimeForStep } from '../../dist/index.js';
import { retimeDrift } from './retime-drift.js';

const LOOKAHEAD = 0.15; // seconds of audio scheduled ahead
const $ = id => document.getElementById(id);

const ctx = new AudioContext();
const clock = new NcClock({ bpm: 120, timebase: 'shared' }); // times are shared seconds (same in every tab)
const mapper = new AudioClockMapper(ctx);                    // shared time <-> this tab's audio time
// Clicks handed to the audio graph and not yet played, so a confirmed device clock step can move them.
const queued = [];
const peer = new NcSyncPeer({
  app: 'nc-clock metronome', version: '0.1.0', clock,
  audio: () => (ctx.state === 'running' ? 'running' : 'needs-gesture'),
  outputLatencyMs: () => mapper.outputLatencyMs,
});

// The next beat to schedule. Always re-derived from the clock, never from our own running time.
let nextBeat = 0;
const resync = () => {
  const t = clock.transport;
  nextBeat = t.running ? Math.max(Math.ceil(t.beatAt(sharedNow() + 0.02) - 1e-9), Math.ceil(t.beatAt(t.startTime ?? 0) - 1e-9)) : 0;
};
clock.onChange(resync);

function click(when, accent, beat) {
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.frequency.value = accent ? 1760 : 880;
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(0.5, when + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
  osc.connect(gain).connect(ctx.destination);
  osc.start(when); osc.stop(when + 0.06);
  queued.push({ osc, when, accent, beat });
}

// A confirmed device clock step: every click not yet rendered moves by the step (cancel and re-create, since a
// started source cannot be moved), so it lands on the shared grid. See docs/nc-clock.md, "Device clock steps".
mapper.onStep(step => {
  const renderedUntil = ctx.currentTime + 128 / ctx.sampleRate;
  const moving = [];
  for (let i = queued.length - 1; i >= 0; i--) {
    const q = queued[i];
    if (q.when + 0.06 < ctx.currentTime) { queued.splice(i, 1); continue; }
    const when = retimeForStep(q.when, step, renderedUntil);
    if (when === q.when) continue;
    q.osc.stop(0); q.osc.disconnect(); queued.splice(i, 1);
    moving.push({ ...q, when });
  }
  for (const q of moving) click(q.when, q.accent, q.beat);
});

createTicker(() => {
  const t = clock.transport;
  // ready is a plain read; sampleIfNotReady() takes a sample from each new output timestamp until it is true.
  if (!t.running || !mapper.sampleIfNotReady() || ctx.state !== 'running') return;
  const now = mapper.toSharedTime(ctx.currentTime);
  if (t.timeAt(nextBeat) < now - 0.1) resync();             // after a stall, skip ahead instead of a burst
  while (t.timeAt(nextBeat) < now + LOOKAHEAD) {
    const when = mapper.toContextTime(t.timeAt(nextBeat));
    if (when >= ctx.currentTime) click(when, t.position(nextBeat).beatInBar === 0, nextBeat);
    while (queued.length && queued[0].when + 0.06 < ctx.currentTime) queued.shift();
    nextBeat += 1;
  }
  // Clicks keep the mapping of the moment they were queued; move any that the audio clock's drift has pushed off
  // the current mapping (see retime-drift.js). Cancel and re-create, as for a device clock step.
  for (const { event: q, when } of retimeDrift(queued, q => mapper.toContextTime(t.timeAt(q.beat)), ctx.currentTime)) {
    q.osc.stop(0); q.osc.disconnect();
    click(when, q.accent, q.beat);
  }
}).start();

// Display (not timing-critical).
function draw() {
  const t = clock.transport, p = t.position(t.beatAt(sharedNow()));
  $('beat').textContent = t.running ? `${p.bar + 1} . ${Math.floor(p.beatInBar) + 1}` : '–';
  const others = [...peer.peers.values()].map(i => `${i.app}${i.leader ? ' (leader)' : ''}`).join(', ') || 'none';
  $('status').textContent = `${peer.isLeader ? 'Leader' : 'Follower'} · ${t.bpm.toFixed(1)} BPM · audio ${ctx.state}\nOther peers: ${others}`;
  requestAnimationFrame(draw);
}

$('play').onclick = async () => { await ctx.resume(); clock.play({ at: sharedNow() }); };
$('stop').onclick = () => clock.stop({ at: sharedNow() });
$('bpm').onchange = e => clock.setTempo({ bpm: Number(e.target.value) });
clock.onChange(() => { $('bpm').value = String(Math.round(clock.transport.bpm * 10) / 10); });

mapper.start();
await peer.start();
draw();
