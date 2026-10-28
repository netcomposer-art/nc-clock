# nc-clock

nc-clock was created by [Peter Semmelhack](https://psem.me/).

**A universal beat clock for music apps, plus NC Sync v1: a small, open protocol so separate apps (tabs, windows,
processes) play in time together.** One app is the leader; everyone else follows its clock. Any app can join: a synth,
a drum machine, a looper, a visualizer, a metronome.

- **Zero dependencies.** TypeScript, ESM, types included. About 1,400 lines.
- **Pure core.** Beat ↔ time math with a tempo map, transport and meter. It never reads a clock itself (you pass
  times in), so it runs anywhere: the main thread, a Worker, an **AudioWorklet**, Node, Deno.
- **No drift.** Every event time is computed from one anchor, never by adding step lengths. 20,000 steps later,
  the error is still zero.
- **Browser adapters.** An AudioContext time mapper, a background-proof ticker, and an NC Sync peer over
  BroadcastChannel with Web Locks leader election.
- **Open protocol.** Versioned, vendor-neutral JSON ([docs/nc-sync-v1.md](docs/nc-sync-v1.md)), so a peer can be
  written in any language.

MIT licensed. Package name `@netcomposer/nc-clock` (not yet published to npm).

---

## How it works (in 30 seconds)

A clock is just "**beat B happens at time T**, at this tempo". That pair is the *anchor*. Tempo changes are
points on a *tempo map* ("from beat 16, 128 BPM"). Ask the clock "when is beat 33.5?" or "what beat is it at
time T?" and it does the arithmetic from the anchor. Because every answer comes from the same anchor, two apps
holding the same snapshot compute the same times, to the bit.

Syncing = sharing that snapshot. The leader decides *when* things happen (start on the next bar, change tempo on
the next beat) and broadcasts a `state` message. Followers apply it and schedule their own sounds.

```
 leader app ── state {anchor, tempo map, playing} ──▶ follower apps
     ▲                                                     │
     └──── requests: transport / tempo (Play, Stop, BPM) ──┘
```

---

## 5-minute quick start: add a new destination

### 1. Install

```bash
npm install @netcomposer/nc-clock       # once published; for now: copy this folder or npm link it
```

### 2. Run your app on the clock (standalone)

```ts
import { NcClock } from '@netcomposer/nc-clock';

const ctx = new AudioContext();
const clock = new NcClock({ bpm: 120, timebase: 'audio' });     // times are AudioContext seconds

clock.play({ at: ctx.currentTime + 0.05 });                    // beat 0 at that time
clock.transport.timeAt(4);       // → when beat 4 sounds (seconds on ctx.currentTime)
clock.transport.beatAt(ctx.currentTime);                         // → beat now
clock.setTempo({ bpm: 90, atBeat: 8 });                          // tempo change exactly on beat 8
```

### 3. Schedule with a lookahead (the usual Web Audio pattern)

```ts
import { createTicker } from '@netcomposer/nc-clock';

let nextBeat = 0;
const ticker = createTicker(() => {
  const t = clock.transport, horizon = ctx.currentTime + 0.15;
  while (t.running && t.timeAt(nextBeat) < horizon) {
    playClick(t.timeAt(nextBeat), nextBeat % 4 === 0);   // start an oscillator at that exact time
    nextBeat += 1;                                       // a beat number, not a time: no drift
  }
});
ticker.start();   // a Worker timer plus a fallback, so hidden tabs keep ticking
```

### 4. Join NC Sync (play with other apps)

Shared time is wall-clock seconds, the same in every tab. Run your clock on that timeline and convert to your
AudioContext only when scheduling:

```ts
import { NcClock, NcSyncPeer, AudioClockMapper, createTicker, sharedNow } from '@netcomposer/nc-clock';

const clock = new NcClock({ timebase: 'shared' });
const mapper = new AudioClockMapper(ctx);   // shared time ↔ ctx time, output latency included
mapper.start();

const peer = new NcSyncPeer({ app: 'My App', version: '1.0.0', clock, audio: () => ctx.state === 'running' ? 'running' : 'needs-gesture' });
await peer.start();      // joins; finds or becomes the leader

// Your Play button: now a request. The leader picks the time; every app starts together.
playButton.onclick = () => { ctx.resume(); clock.play({ at: sharedNow() }); };
clock.onChange(change => { if (change.kind === 'start' || change.kind === 'snapshot') nextBeat = Math.ceil(clock.transport.beatAt(sharedNow())); });

createTicker(() => {
  const t = clock.transport, now = mapper.toSharedTime(ctx.currentTime);
  while (t.running && t.timeAt(nextBeat) < now + 0.15) {
    playClick(mapper.toContextTime(t.timeAt(nextBeat)), nextBeat % 4 === 0);
    nextBeat += 1;
  }
}).start();
```

That is the whole integration. A runnable version is in [examples/metronome](examples/metronome): open it in two
tabs and they click together. If you queue notes far ahead, see `examples/metronome/retime-drift.js`: it keeps
queued notes on the current mapping while the audio clock drifts.

```bash
npm install && npm run example     # then open http://localhost:8080/examples/metronome/ in two tabs
```

---

## API reference

Everything is exported from `@netcomposer/nc-clock`. The pure core is also at `@netcomposer/nc-clock/core`
(safe for an AudioWorklet) and the protocol types at `@netcomposer/nc-clock/protocol`.

### Core (pure: no DOM, timers, `performance` or `Date`)

| Export | What it does |
|---|---|
| `new TempoMap({ bpm, anchor?, minBpm?, maxBpm?, maxPoints? })` | Piecewise-constant tempo from an anchor. `timeAt(beat)`, `beatAt(time)`, `bpmAt(beat)`, `setTempoAt(bpm, beat)`, `rampTempo(toBpm, startBeat, beats, stepBeats?)` (a ramp as small steps), `restart(anchor, bpm)`, `shift(seconds)`, `clone()`. |
| `new Transport({ bpm?, meter?, minBpm?, maxBpm? })` | A tempo map plus start/stop. `start({ at, beat?, bpm? })`, `stop({ at })`, `running`, `isPlayingAt(t)`, `beatAt(t)` (frozen while stopped), `timeAt(beat)`, `setTempo(bpm, atBeat?)`, `position(beat)` → `{ bar, beatInBar, barPhase }`, `nextBar(beat)`, `meter`. |
| `new NcClock({ bpm?, meter?, timebase? })` | A transport with an **authority seam**. `play(req)`, `stop(req)`, `setTempo(req)`: standalone they apply at once (and return `true`); with an authority set they become requests (and return `false`). `commitStart/commitStop/commitTempo`, `applySnapshot(s)`, `toSnapshot()`, `onChange(fn)` (changes from now on), `subscribe(fn)` (the current state at once as `{ kind: 'snapshot', replay: true }`, then every change), `setAuthority(a)`, `external`. |
| `ClockAuthority` | `{ requestStart, requestStop, requestTempo }`: implement it to plug in any sync source (NC Sync, MIDI clock, Ableton Link bridge, a server). |
| `toSnapshot(transport, timebase)` / `fromSnapshot(snap)` / `applySnapshot(transport, snap)` | JSON-safe state, `version: 1`. A round trip gives identical `beatAt`/`timeAt` results. |
| `shiftSnapshot(snap, offsetSeconds, timebase)` | Move a snapshot to another timeline (e.g. shared time → AudioContext time). |
| `validateSnapshot(x)` | Throws on a malformed snapshot. |
| `nextGridBeat(beat, grid, strict?)`, `floorBeat`, `clampBpm` | Grid helpers. |
| `DEFAULT_METER`, `SNAPSHOT_FORMAT`, `SNAPSHOT_VERSION`, `NC_CLOCK_VERSION` | Constants. |

### Browser adapters

| Export | What it does |
|---|---|
| `new AudioClockMapper(ctx, { samples?, intervalMs?, userOffsetMs?, stepThresholdMs?, stepConfirmations?, stepCheckMs?, stepConfirmMs?, stepRevertMs? })` | Maps shared time ↔ AudioContext time using `getOutputTimestamp()` and `outputLatency`, a median of recent samples, guards for suspended, zero and placeholder readings, and a re-read when the output device changes. Re-anchors at once on a confirmed device clock step. `start()`, `stop()`, `toContextTime(shared)`, `toSharedTime(ctxTime)`, `offset`, `ready` (a plain read: true after three real samples; stays true across steps, resets on a real suspend/resume or a device change), `sampleIfNotReady()` (takes a sample while not ready; returns `ready`), `onStep(fn)` (`revert: true` when a transient is taken back), `checkStep()`, `reanchors` (lasting), `reverts`, `outputLatencyMs`. See docs/nc-clock.md. |
| `retimeForStep(when, step, renderedUntil)` | Moves a queued context-time event by a confirmed step if it is not yet rendered. |
| `createTicker(onTick, { intervalMs?, worker? })` | A ~20 ms tick from a Worker timer (not throttled in hidden tabs) plus a main-thread fallback, de-duplicated. `start()`, `stop()`, `dispose()`, `kind`. |
| `sharedNow()` | Shared time: `(performance.timeOrigin + performance.now()) / 1000`. |
| `new NcSyncPeer({ app, version, clock, capabilities?, channel?, locks?, … })` | An NC Sync v1 participant. `start()`, `stop()`, `isLeader`, `peers`, `onRole(fn)`, `onPeers(fn)`, `onSnapshot(fn)`, `onMessage(fn)`, `sendSnapshot(op, slot, extra?)`, `tempoRange()`. Swing: pass `swing: () => value` (0.5 straight to 0.75) to send yours while leading; read the session's with `swing` (null until a leader sets one) and `onSwing(fn)`; call `publishState()` after a swing edit (leader only; returns false on a follower). |

### Protocol

`PROTOCOL` (`"nc-sync/1"`), `PROTOCOL_MAJOR`, `DEFAULT_CHANNEL` (`"nc-sync"`), `LEADER_LOCK`, `MESSAGE_TYPES`,
`DEFAULT_CAPABILITIES`, `parseMessage(x)` (validate; returns `null` for anything to ignore), `envelope(body, …)`
and a TypeScript type for every message.

Every export has JSDoc; your editor shows it on hover.

---

## Protocol messages (NC Sync v1)

The normative spec is [docs/nc-sync-v1.md](docs/nc-sync-v1.md). All messages are JSON objects on one channel
(by default `new BroadcastChannel("nc-sync")`). Times are **shared seconds** (Unix epoch, with fractions).

Every message carries the envelope:

```json
{ "proto": "nc-sync/1", "type": "heartbeat", "from": "3f2a…", "term": 4, "seq": 118, "sentAt": 1761580800.731 }
```

**hello**: sent when joining. The leader answers with `state`, everyone else with a `heartbeat`.

```json
{ "proto": "nc-sync/1", "type": "hello", "from": "b81c…", "term": 0, "seq": 1, "sentAt": 1761580799.1,
  "app": "Example Drums", "version": "2.3.0", "joinedAt": 1761580799.1, "audio": "needs-gesture", "outputLatencyMs": 21.3,
  "capabilities": { "tempoRange": [40, 240], "tempoRamps": false, "swing": true, "meter": true,
                    "prefersLeader": true, "canLead": true, "sampleAccurate": true } }
```

**state**: leader only; the full clock. Followers apply it as is.

```json
{ "proto": "nc-sync/1", "type": "state", "from": "b81c…", "term": 4, "seq": 52, "sentAt": 1761580800.05,
  "leaderApp": "Example Drums", "swing": 0.58,
  "clock": { "format": "nc-clock/snapshot", "version": 1, "timebase": "shared",
             "anchor": { "beat": 0, "time": 1761580800.25 },
             "tempo": [ { "beat": 0, "bpm": 120 }, { "beat": 16, "bpm": 128 } ],
             "meter": { "beatsPerBar": 4, "beatUnit": 4 },
             "playing": true, "startTime": 1761580800.25, "stopTime": null, "stoppedBeat": 0 } }
```

**transport** / **tempo**: requests to the leader (from Play, Stop, or a tempo control).

```json
{ "proto": "nc-sync/1", "type": "transport", "from": "3f2a…", "term": 4, "seq": 9, "sentAt": 1761580803.2, "action": "start" }
{ "proto": "nc-sync/1", "type": "transport", "from": "3f2a…", "term": 4, "seq": 10, "sentAt": 1761580809.0, "action": "stop", "all": true }
{ "proto": "nc-sync/1", "type": "tempo", "from": "3f2a…", "term": 4, "seq": 11, "sentAt": 1761580811.4, "bpm": 96 }
```

**heartbeat** (about every second), **bye**, **snapshot** (recall a preset slot on a beat), and **ping/pong**
(relay mode) are in the spec. Rules: ignore unknown types and fields, drop messages with another major version,
drop repeats of (`from`, `seq`), never re-broadcast.

---

## Timing guarantee

With `AudioClockMapper` re-mapping the device clock, beat timing error is:

- **Re-mapped p95 ≤ 1 ms.**
- **Max ≤ 3 ms.**
- **At most 1 beat over 3 ms per 10 minutes per tab.** That one beat is the one that can slip when a real device clock
  jump lands on audio already in the device's output buffer (computed ~outputLatency + one render quantum before
  it is heard, so no mapper change can move it).

These numbers are unchanged. p95 ≤ 1 ms and max ≤ 3 ms are enforced in CI (test/drift.test.ts). The
at-most-1-beat-over-3-ms-per-10-minutes-per-tab limit is part of the guarantee but isn't yet checked automatically:
neither this repo nor the Bass, Rhythm or Synth apps gate a 10-minute session on it in CI. ASTRID-Rhythm's
sync:measure counts beats over 3 ms against this allowance, but its CI run is 2 minutes and non-blocking.

A reverted excursion (a blip: a confirmed step whose readings come back within `stepRevertMs`) is not a real device
clock event and does not claim the one-beat allowance. Beats off during a blip count against the normal limit of at
most 1 beat over 3 ms per 10 minutes per tab. Beats during a blip can still be more than 3 ms off: in a 50-seed
replay of OLIVE Bass's hidden-tab run 3 (the profile in test/clock-blips.test.ts), the worst beat was 5.3 ms off
with and without the provisional step, and 10–13% of beat phases in the 500 ms around the excursion were over 3 ms.
Rejecting blips early is deferred until real sessions show it matters.

## Browser support and limits

| | |
|---|---|
| Core | Any ES2022 runtime (browsers, Node ≥ 20, Deno, Bun, AudioWorklet). |
| `NcSyncPeer` | BroadcastChannel: Chrome/Edge 54+, Firefox 38+, Safari 15.4+. Web Locks (better elections): Chrome 69+, Firefox 96+, Safari 15.4+; without them the oldest peer leads. |
| `AudioClockMapper` | `getOutputTimestamp`: Chrome 57+, Firefox 70+; Safari falls back to `currentTime − outputLatency`/`baseLatency`. |
| `createTicker` | Uses a Blob Worker when a `document` exists; else timers only. |

Limits, honestly:

- **Same browser, same machine.** BroadcastChannel only reaches tabs of one browser profile on one origin. Across
  origins, devices or browsers you need a relay (a WebSocket server that forwards messages; the protocol has
  `ping`/`pong` for this). Not included in 0.1.0.
- **Accuracy** is as good as each app's scheduling: about ±1 ms between apps that schedule on the audio thread, a
  few ms for main-thread lookahead schedulers. Bluetooth output adds latency the browser may misreport; use
  `userOffsetMs`.
- **Hidden tabs.** Browsers throttle background timers (1 s, later 1 min). The Worker ticker is exempt, and a tab that is
  playing sound is not throttled anyway. Heartbeats from hidden tabs can be up to a minute apart, so peers wait
  65 s before dropping a hidden peer.
- **Autoplay.** A tab can't make sound until the user clicks it once. Peers report `audio: "needs-gesture"` so the
  leader app can say "click the drum tab".
- **Tempo ramps** are sent as stepped tempo points (every 1/4 beat by default), which sounds smooth and stays exact.

---

## Credits

nc-clock was created by [Peter Semmelhack](https://psem.me/). See [AUTHORS](AUTHORS) and [NOTICE](NOTICE): if you
fork or redistribute it, please keep that credit. Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

MIT License. Copyright (c) 2026 Peter Semmelhack.
