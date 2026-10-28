# NC Sync protocol, version 1

Status: **v1, draft for implementers** (nc-clock 0.1.0). NC Sync was created by [Peter Semmelhack](https://psem.me/).

NC Sync lets independent music apps share one beat clock. It is plain JSON over any ordered broadcast channel, so it
can be implemented in any language. The reference implementation is `NcSyncPeer` in nc-clock.

The key words MUST, SHOULD and MAY are used as in RFC 2119.

## 1. Model

- **Peers** join a **channel**. In browsers this is `new BroadcastChannel("nc-sync")` (same origin, same profile).
  Other transports (a WebSocket relay, `postMessage`, a local socket) MAY carry the same messages unchanged.
- One peer is the **leader**. It owns the clock: it decides when starts, stops and tempo changes happen, and
  broadcasts the result as `state`. Everyone else is a **follower**.
- Any peer MAY *request* a start, stop or tempo change. Only the leader *decides*.
- **Shared time**: all times on the wire are seconds since the Unix epoch, with fractions, from a monotonic
  source aligned to the wall clock. In browsers: `(performance.timeOrigin + performance.now()) / 1000`.
- **The clock** is a snapshot: an anchor (beat B at shared time T), a tempo map, a meter, and play state. Every
  peer computes event times from the snapshot (section 5). There is no tick stream.

## 2. Envelope

Every message is a JSON object with these fields:

| Field | Type | Meaning |
|---|---|---|
| `proto` | string | `"nc-sync/1"`. Receivers MUST drop messages whose major version differs. |
| `type` | string | Message type (section 3). Receivers MUST ignore unknown types. |
| `from` | string | Sender instance id, unique per tab/process (a UUID is fine). |
| `term` | integer ≥ 0 | Leader term the sender knows. |
| `seq` | integer ≥ 1 | Sender's message counter, strictly increasing. |
| `sentAt` | number | Sender's shared time at sending. |

Rules:
- Receivers MUST ignore unknown fields.
- Receivers MUST drop a message whose `seq` is not greater than the last `seq` seen from the same `from` (dedupe).
- A receiver MUST NOT re-broadcast a message it received.
- A receiver MUST ignore its own messages.

## 3. Messages

### hello
Sent once on joining. The leader MUST answer with `state`; every other peer SHOULD answer with a `heartbeat`, so the
newcomer learns who is present.

| Field | Type | |
|---|---|---|
| `app`, `version` | string | Human-readable app name and version. |
| `capabilities` | Capabilities | Section 4. |
| `audio` | AudioReadiness | `"running"`, `"suspended"`, `"interrupted"`, `"needs-gesture"` or `"none"`. |
| `outputLatencyMs` | number or null | Output latency the peer measured. |
| `joinedAt` | number | Shared time the peer joined. |
| `playing` | boolean, optional | This instrument plays (only with the `independentStop` capability; see [Member play state](#member-play-state-independentstop)). |

### heartbeat
Every ~1 s: `app`, `leader` (bool), `audio`, `hidden` (bool), `outputLatencyMs`, `joinedAt`, `capabilities`, and
`playing` (bool) with `independentStop`. A peer with `independentStop` also sends a heartbeat at once when its
`playing` changes.
A follower playing in a running session MAY add `swing` (number) to send a session swing edit to the leader; see [Swing](#swing).
A peer that knows no other peer MAY stop beating while alone, until one appears (nobody is listening; every peer
still answers a `hello` with a heartbeat, so a newcomer learns who is there). Such a peer SHOULD send one heartbeat
when its page is shown again (it may have missed a `hello` while frozen in the background).
Hidden tabs are throttled by browsers, so a peer with `hidden: true` MAY beat as rarely as once a minute. Peers
SHOULD consider a visible peer gone after 3 s of silence, and a hidden one after 65 s.

### bye
Leaving. Best effort; liveness also comes from heartbeats and (in browsers) the leader lock.

### state (leader only)
The whole clock. Followers MUST apply it as is.

| Field | Type | |
|---|---|---|
| `clock` | ClockSnapshot | Section 5. |
| `swing` | number | Session swing, or `0` for unset. See [Swing](#swing). |
| `leaderApp` | string | Leader's app name. |
| `stopAll` | boolean, optional | With a stop: also stop free-running arps/sequences (see `transport`). |
| `independentStop` | boolean, optional | The leader runs per-instrument Stop ([Member play state](#member-play-state-independentstop)). |
| `endSession` | boolean, optional | With a stop from an `independentStop` leader: every instrument stops (an explicit stop-all, or an old peer's Stop). |

The leader MUST send `state` after every decision, in reply to every `hello`, and when it becomes leader. A
`state` reply to `hello` carries the current anchor and play state, so a late joiner can start mid-bar on the next
grid line (the beat at any time is computable from the snapshot).

A leader MAY send `state` again at any time with nothing else changed (for example after a swing edit). Followers
apply it like any other; an unchanged clock does not move the beat. Followers MUST NOT send `state` and MUST NOT
answer one with a message.

#### Swing
`swing` is where the second 16th of each 8th-note pair lands, as a fraction of the pair: `0.5` is straight, `0.667`
is triplet feel, `0.75` (the maximum in v1) is dotted. It applies to 16ths counted from the anchor's beat grid;
peers with the `swing` capability play it, others ignore it.

- `0` means "this leader does not set swing". nc-clock 0.1.0 always sent `0`, so old leaders stay compatible.
- A receiver MUST ignore any value outside 0.5–0.75 (including `0`, non-numbers and NaN) and keep the swing it
  had. It MUST still apply the rest of the `state`.
- A leader SHOULD send its current swing in every `state` and SHOULD send `state` promptly when swing changes.
  It MUST clamp its own value to 0.5–0.75, or send `0`.
- Swing is not part of the clock snapshot (section 5): the snapshot says when beats happen; swing is how a
  pattern sits on them. Adding it later would be a minor snapshot version (1.x), which v1 readers accept.
- A peer that does not lead MAY send a swing edit as `heartbeat.swing` (0.5–0.75), but only while it plays in a
  running session; a peer that has not joined, or has stopped, MUST NOT send one (its own swing stays local, so it
  cannot replace the session swing). The leader SHOULD apply it and
  send `state` with it. Every peer SHOULD keep the latest such edit until a `state` carries that value (or a
  `state` sent more than 0.25 s after the edit), and a new leader SHOULD send a kept edit, so an edit made during a
  handoff is not lost. Older peers ignore the field (a follower's edit then stays local, as before).

Followers MUST ignore `state` with a `term` lower than the highest term they have seen.

### transport (request)
`action`: `"start"` or `"stop"`; optional `atBeat`; optional `all` (stop only).

- **Start** when nothing plays: the leader starts at `now + 0.2 s`, from beat 0.
- **Start** while playing (restart): on the next bar line, from beat 0.
- **Stop**: at `now + 0.1 s`. Stop ends the *transport* only; instruments MAY keep free-running arps or latched
  sequences going, unless `all: true` (then `state.stopAll` is true and they stop everything).

With `independentStop` (below), a peer sends `start` only when no session runs, and `stop` only with `all: true`;
its plain Stop and its Play while a session runs are member changes, not requests. An `independentStop` leader
treats a `start` while running as a Join (it MUST NOT restart the grid), and a `stop` from any peer as a stop of
the whole session (`endSession: true`), which is what an old peer's Stop means.

#### Member play state (`independentStop`)
Each instrument stops on its own; the session grid (the clock snapshot) is separate from who plays on it.

- A peer with the `independentStop` capability sends `playing` in `hello` and `heartbeat`. Stop in that peer stops
  only that instrument: it sets `playing: false` locally and beats once, and the grid runs on unchanged. Play while
  a session runs is a **Join**: the instrument starts on the next grid line it chooses (nc-clock: the next whole
  beat, `NcClock.joinPoint`), with the session's tempo map, meter and swing. The grid is never restarted.
- The leader ends the session (a normal stop, `state.independentStop: true`) only when no member plays: its own
  instrument stopped and every `independentStop` peer reports `playing: false`. A peer without the capability
  counts as playing while the session runs; a peer that times out or says `bye` counts as stopped.
- `state` with `playing: false` and `endSession`, `stopAll`, or no `independentStop` (an old leader) stops every
  instrument. Without those flags it ends an idle session; an instrument that is still playing (a Join crossed the
  stop) sends `start`, and the leader keeps the run if its stop has not landed yet (else starts a new one). The
  leader SHOULD also keep a run whose idle stop is still pending as soon as a member's `heartbeat` says it plays, so
  the Join never depends on that `start` arriving in time.
- **Handoff.** When every peer that can lead has `independentStop`, the leader ranking puts playing peers first
  while the session runs (section 6). With no session running, play state does not rank: a Play there is a `start`
  for the current leader, and moving the lead at that moment could lose it. A new leader whose own instrument plays
  while no session runs (or one is ending) starts or keeps the run itself. A leader that stops while others play hands the lead to a playing peer; the new leader sends the
  snapshot unchanged (same anchor, tempo map, meter, start time) with a higher `term`, and keeps the session's
  swing until its app publishes its own. A beat is at the same time before and after the handoff.
- **Mixed sessions.** While any known peer lacks `independentStop`, a Stop on an `independentStop` peer is the
  session stop for everyone, as in 0.4.0 (a leader's `state` with `endSession`, or a follower's `transport` stop
  without `all`), so an old peer never plays on alone; decided per Stop from the peers known at that moment. If any
  peer that can lead lacks `independentStop`, every peer uses the plain ranking of section 6, so old and new peers
  agree on one leader, and there is no play-state handoff. An old peer's Stop stops everyone (as before); an old
  peer's Play on a running session joins it.

### tempo (request)
`bpm`; optional `atBeat`; optional `rampBeats`.
The leader clamps `bpm` to the intersection of all peers' `tempoRange`, and applies it at `atBeat` or else at the
next whole beat at least 0.1 s ahead. A ramp is expanded by the leader into stepped tempo points in the map
(default every 1/4 beat), so peers without ramp support still follow exactly.

### snapshot (any peer)
Preset slots, for apps that have them.

| Field | | |
|---|---|---|
| `op` | `"recall"`, `"stopSequence"`, `"store"` | `recall` is idempotent (never toggles). `store` is opt-in per app (it overwrites the user's slot); apps MAY ignore it. |
| `slot` | integer | Slot number. |
| `atBeat` | number, optional | Beat it takes effect. |
| `glide` | `{ beats?, seconds? }`, optional | Morph time; the sender's glide wins. |

### ping / pong (relay mode only)
`ping { id }`, answered by `pong { id, receivedAt }`, for estimating clock offset over a network relay.

### notes
Reserved for a future version. Receivers MUST ignore it in v1.

## 4. Capabilities

| Field | Type | |
|---|---|---|
| `tempoRange` | `[min, max]` | Tempo the peer can play. |
| `tempoRamps` | bool | Follows ramps natively. |
| `swing` | bool | Plays `state.swing` (and its app may set it while leading). |
| `meter` | bool | Has its own meter; else it uses the leader's (default 4/4). |
| `prefersLeader` | bool | Wants to lead (e.g. its sequencer runs on the audio thread). |
| `canLead` | bool | Can lead at all. |
| `sampleAccurate` | bool | Schedules on the audio thread. |
| `modes` | string[], optional | Free-form modes in which it follows the transport. |
| `independentStop` | bool, optional | Stop stops only this instrument; it sends `playing` ([Member play state](#member-play-state-independentstop)). Absent means `false`. |

Defaults: `{"tempoRange":[20,300],"tempoRamps":false,"swing":false,"meter":false,"prefersLeader":false,"canLead":true,"sampleAccurate":false}`.

## 5. Clock snapshot (`nc-clock/snapshot`, version 1)

```json
{
  "format": "nc-clock/snapshot", "version": 1, "timebase": "shared",
  "anchor": { "beat": 0, "time": 1761580800.25 },
  "tempo": [ { "beat": 0, "bpm": 120 }, { "beat": 16, "bpm": 128 } ],
  "meter": { "beatsPerBar": 4, "beatUnit": 4 },
  "playing": true, "startTime": 1761580800.25, "stopTime": null, "stoppedBeat": 0
}
```

- `tempo` is sorted by beat; the first point is at or before the anchor beat. Tempo is constant between points.
- **Time of beat b**: walk the points from the anchor, adding `(segment beats) × 60 / bpm` per segment. Beat of
  time t is the inverse. Implementations MUST compute each event time from the anchor like this, not by adding
  step lengths to the previous event (that drifts).
- While `playing` is false, the beat is frozen at `stoppedBeat`. `stopTime`, when set, is when it stopped.
- A snapshot can be moved to another timeline by adding an offset to `anchor.time`, `startTime` and `stopTime`.
- Unknown `version`: drop the snapshot.

## 6. Leader election

- **With Web Locks** (browsers): peers that can lead request the lock `"nc-sync-leader"`; the holder leads. A holder
  without `prefersLeader` that sees a `prefersLeader` peer yields (releases the lock and withdraws).
- **Without locks**: the leader is the eligible peer ranked first by `prefersLeader`, then oldest `joinedAt`, then
  lowest `from`. When every peer that can lead has `independentStop` and the session runs, a playing peer ranks
  before a stopped one (then `prefersLeader`, `joinedAt`, `from`); with locks, a stopped holder yields to a playing peer, and a holder
  without `prefersLeader` yields to a playing one with it. A newcomer SHOULD listen for a short grace period (nc-clock: 300 ms) before claiming the lead, so it
  never competes with a leader that is already running.
- On becoming leader a peer increments `term` past any it has seen and broadcasts `state`. The anchor carries over,
  so a leader change does not move the beat.
- If two leaders' `state` messages cross, the higher `term` wins; on a tie the better-ranked peer (the order above) keeps
  leading.

## 7. Audio and timing guidance (non-normative)

- Convert shared time to your audio clock with the output timestamp and latency (nc-clock's `AudioClockMapper`).
  Re-read output latency when the output device changes and every few seconds.
- Schedule from a Worker timer or the audio thread. Browsers throttle hidden, silent tabs' main-thread timers to
  1 s, and later 1 min.
- A peer whose `audio` is `needs-gesture` can't sound until clicked; leaders SHOULD tell the user.
