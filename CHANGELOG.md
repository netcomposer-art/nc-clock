# Changelog

All notable changes to nc-clock are listed here. This project follows [Semantic Versioning](https://semver.org/).
The NC Sync protocol has its own major version (`proto: "nc-sync/1"`); see docs/nc-sync-v1.md.

## [0.5.0] - Unreleased

Independent stop. Released after 0.4.0 (#4, snapshot `cancel`; #5, heartbeat only while another peer is known),
in merge order. This branch carries #5's commits (cherry-picked), so the [Unreleased] changes below are in it too;
merge #5 first.

### Added
- Per-instrument Stop, opt-in: `new NcSyncPeer({ …, independentStop: true })`. Stop in one tab stops only that
  instrument; the session grid runs on for the others with no beat jump, and the session ends only when the last
  instrument stops. Play while others play is a Join on the running grid (tempo map, meter and swing included) and
  never restarts it. If the leader stops while others play, the lead hands off to a playing tab: the snapshot is
  sent unchanged (same anchor, tempo map, start time) with the term incremented, and the session swing is carried
  until the new leader's app publishes its own. `clock.stop({ at, all: true })` stays the explicit stop-all
  (`state.stopAll` and `state.endSession`). From the netcomposer.art P1 (Stop in any tab stopped every tab).
- `NcClock`: `playing` (this instrument), `isPlayingAt(t)`, `joinPoint(t, gridBeats?)`, `commitMember(playing, at)`,
  and the `{ kind: 'member', playing, at }` change. `ClockAuthority.independentStop` (optional).
- NC Sync v1 (still `nc-sync/1`): the `independentStop` capability; `playing` in `hello` and `heartbeat`;
  `state.independentStop` and `state.endSession`; a playing-first leader ranking when every peer that can lead has
  the capability. See docs/nc-sync-v1.md, "Member play state".
- `test/e2e/three-tab.mjs` and `examples/three-tab/`: a three-tab e2e (Play first in a tab that does not lead; start
  the rest; stop B; stop the leader; restart B; stop the rest; Play in a non-leading tab again after the end) against
  the sync standard, driven through a small `window.ncE2E` hook instruments can implement to run it in their own
  suites. Timing comes from real Web Audio notes when the tab plays them (`?audio`: the harness reads each
  `OscillatorNode.start` and maps it with the page's own output timestamps), else from the scheduled times.
  `npm run e2e` (needs `playwright-core`; set `PLAYWRIGHT_CORE`); `SKEW_MS=4` is the negative control. Runs in CI.

### Fixed (review of #6 @338b291)
- With Web Locks, Play in a tab that did not lead, with no session running, left it playing on a stopped session
  forever: its own heartbeat moved the lead (playing outranked stopped) while its start request went to the old
  leader, which released the lock and dropped it. Playing now ranks only while the session runs, and a new leader
  whose instrument plays on a stopped or ending session starts (or keeps) the run.
- A tab that joined just as the last instrument stopped no longer depends on its start request: the leader keeps the
  run on its playing heartbeat (no old-grid notes, then a restart, when the request is late or lost).
- `stop()` no longer re-elects the leaving tab (its last beat could time out a peer and re-run the election).
- Swing edits from a tab that does not lead (Petra, on d5d7b86): a follower's Play moves the lead to it, so the
  stopped ex-leader's later swing edit went nowhere. `publishState()` on a follower now sends its swing to the leader
  as a session edit (an optional `swing` field on `heartbeat`, no new message type), and the leader applies and
  broadcasts it. Every peer keeps a pending edit until a `state` carries it (or a `state` sent more than 0.25 s
  later), so a new leader applies it when the lead moves before the old leader did. Apps that only called
  `publishState()` while leading must call it on every swing edit. Tempo already went to the leader (`tempo`).
- Size: the peer was trimmed (shared rank function, listener helpers, no duplicate timer and lock code) so the
  0.5.0 fixes cost almost nothing over 9083844 (min+gz of the bundle 8,792 B there, 8,813 B at 4901c59; 8,748 B once the mixed-session
  fallback was removed).

### Compatibility
- Without `independentStop` (the default) nothing changes: Stop stops the session for everyone, as in 0.4.0 and earlier.
- No mixed sessions (Peter: no compatibility work, every instrument ships together from one domain): every peer
  in an `independentStop` session must have it. The 0.4.0 fallback (any Stop stops everyone while a peer without the
  capability is known, plain ranking) was removed with its tests and the e2e's `?legacy` step.

## [Unreleased]

### Changed (planned for 0.4.0)
- `NcSyncPeer` runs its heartbeat timer only while it knows another peer: it starts when one appears (its `hello`
  or `heartbeat`) and stops when the last one leaves (`bye`) or times out, and on `stop()`. Alone, an idle page no
  longer wakes every `heartbeatMs`. A newcomer still learns about everyone at once, because every peer answers
  `hello` with a heartbeat; taking or losing the lead still announces the role with one heartbeat. New read-only
  getter `beating` (diagnostics and tests). A peer also sends one heartbeat when its page is shown again
  (`visibilitychange` to visible, `pageshow`), so a lone tab that missed a newcomer's `hello` while frozen still
  meets it; skipped without `document`/`window` (Node, workers), and the listeners go on `stop()`.
  docs/nc-sync-v1.md: a peer MAY stop beating while alone (and SHOULD then beat once when shown again). Not a wire
  change: messages, fields and timeouts are unchanged, and peers on 0.3.0 and earlier interoperate. From ASTRID
  (NetComposer-Synth), whose idle perf gate allows at most one timer callback a second on an idle page.
  `stop()` leaves no timer behind when its last heartbeat (sent as it gives up the lead) times out a stale peer
  while another peer is still known (found by ASTRID's suite, which never exited; regression test in
  test/heartbeat.test.ts).

### Added
- `AudioClockMapper` treats a step that comes back within `stepRevertMs` (new option, default 200 ms of audio clock
  time, `0` = off) as a transient: the confirmed step is still applied at once (~20 ms confirmation unchanged),
  but provisionally; when the readings return to the pre-step anchor inside the window, that anchor is restored
  exactly, `reanchors` doesn't keep it, the new `reverts` counts it, and `onStep` fires with `revert: true`.
  From OLIVE Bass hidden-tab run 3 (Olive, ASTRID-Bass docs/sync-results.md).
- `NcClock.subscribe(listener)`: a replaying subscription. It calls the listener at once with the current state
  (`{ kind: 'snapshot', snapshot, replay: true }`), then on every change, so a scheduler attached after Tap to join
  gets a clock on a steady device. `onChange` is unchanged (changes only, now documented). The `snapshot` change
  gains an optional `replay` flag. Pattern from Rhythm's and Bass's `SnapshotFeed` (Petra, Olive).

### Changed
- The mapper's median no longer allocates (a reused scratch array), so the 50 ms step check and every `offset`
  read are allocation-free.
- `AudioClockMapper.ready` stays true across a confirmed step: the samples move with the step instead of being
  replaced by one, so `ready` no longer reads false inside `onStep` (Bass worked around it with its own
  `measured` flag, which it can drop). Suspend/resume: a statechange keeps the samples while the context isn't
  running; on resume they are kept if the context clock kept pace with wall time (within 10 ms), and dropped
  (re-measure, `ready` false until three new samples) if it stood still, as a real suspend does. A sinkchange
  always re-measures. Before, every statechange re-measured.
- README "Timing guarantee" and docs/nc-clock.md: the numbers are unchanged (re-mapped p95 ≤ 1 ms, max ≤ 3 ms, at
  most 1 beat over 3 ms per 10 minutes per tab). A reverted excursion (a blip: a confirmed step whose readings come
  back within `stepRevertMs`) is not a real device clock event and does not claim the one-beat allowance. Beats off
  during a blip count against the normal limit of at most 1 beat over 3 ms per 10 minutes per tab. Beats during a
  blip can still be more than 3 ms off: in a 50-seed replay of OLIVE Bass's hidden-tab run 3 (the profile in
  test/clock-blips.test.ts), the worst beat was 5.3 ms off with and without the provisional step, and 10–13% of beat
  phases in the 500 ms around the excursion were over 3 ms. Rejecting blips early is deferred until real sessions
  show it matters.

### Fixed
- `AudioClockMapper.sample()` keeps one sample per output timestamp. `start()` and the first `sampleIfNotReady()`
  in the same task read the same stamp, and it counted twice, so `ready` came after two real readings instead of
  three. Found by Olive (OLIVE Bass).
- A real output stamp that stays unchanged while the context runs (stuck) no longer leaves the mapper unready
  forever with that dedupe: after 500 ms (`STAMP_WAIT_MS`) on one unchanged stamp while not ready, it falls back to
  `currentTime − outputLatency`, as for placeholder stamps. Once ready, a stuck stamp keeps the anchor. (0.3.0
  counted the stuck stamp three times and was ready in three ticks.) Found in review (Zeta).
- `NcSyncPeer` forgets a peer's message sequence number when that peer times out (a tab closed without `bye`) and
  on `stop()`. Before, one entry (about 100 B) per closed tab stayed for the life of the page. Found in ASTRID's
  multi-tab crash soak (NetComposer-Synth fix/crash-soak 7ea28c8).
- `AudioClockMapper.stop()` also closes an open revert window and drops the pause record, so after a restart a
  reading back at an old anchor is a new step, not a revert of a window from before the stop. Found in review (Zeta).

### Migration (consumers)
Checked against OLIVE Bass `apps/bass/src/app/sync-clock.test.ts` (psemmelhack/ASTRID-Bass, branch
olive/bass-css-nc-clock at 7bad965, vitest). On 0.3.0 all 6 pass. Three of them rely on 0.3.0 behaviour; on this
release two fail and one passes but gets there later:
- "waits for the mapper to be ready (3 real stamps), then publishes an audio-time snapshot at once": it relied on
  the double-counted stamp (`start()` plus the first `sampleIfNotReady()` on the same stamp counted as two
  readings, so one more poll made three). One stamp is now one sample, so `ready` needs three distinct stamps: the
  first snapshot comes one poll later, at `2 × READY_POLL_MS` instead of `READY_POLL_MS`. Advance two polls (fails
  as written).
- "a listener added after attachAudio gets the current snapshot at once, even when nothing changes": its context
  gives one constant real stamp (`{ contextTime: 3, performanceTime: 1000 }`), a stuck stamp. 0.3.0 counted it on
  every sampler tick and was ready in about three ticks. With one-sample-per-stamp alone it would never get ready;
  now it falls back to `currentTime − outputLatency` after `STAMP_WAIT_MS` (500 ms) on the unchanged stamp, so it
  is ready at ~500 ms and the offset comes from the fallback rather than the stamp. Passes as written (exactly at
  its `REPOST_MS × 2` = 500 ms advance, with no margin); give it a stamp that moves, or advance past 500 ms.
- "re-arms the ready wait when the mapper re-measures (statechange), and publishes when ready again": it dispatches
  `statechange` while the context stays `running`. 0.3.0 re-measured on every statechange; now the samples are kept
  when the context clock kept pace, so `audioSnapshot()` stays non-null and there is no second snapshot (fails as
  written). To test the re-measure, go `suspended` (dispatch), advance wall time more than 10 ms without
  `currentTime` moving, then back to `running` (dispatch): the mapper re-measures, `ready` is false, and the ready
  poll publishes again. A `sinkchange` still always re-measures.
With the first and third changed as described, all 6 pass on this release (checked locally, nothing pushed to
Bass). Bass can also drop its own `measured` flag (`ready` now stays true across steps, including inside `onStep`) and its
`onSnapshot` replay (`NcClock.subscribe`).

## [0.3.0] - Unreleased

Device clock step handling and a correct first reading for `AudioClockMapper`. **Breaking:** `ready` no longer
takes a sample (see Changed and the migration note).

### Changed
- Documented the timing guarantee (README, "Timing guarantee"): after re-mapping, beat error p95 ≤ 1 ms and
  max ≤ 3 ms, with at most 1 beat over 3 ms per 10 minutes per tab (the one beat a real device clock jump can slip
  when it hits audio already in the device buffer).
- **Breaking:** `AudioClockMapper.ready` is now a pure getter: reading it never takes a sample. The sampling it
  did moved to a new method, `sampleIfNotReady(): boolean`, which takes one sample while not ready (only when the
  output timestamp is new) and returns `ready`.

  Migration: code that polled `mapper.ready` to make progress (a ticker that waits for `ready` before scheduling)
  must call `mapper.sampleIfNotReady()` instead. Code that only reads `ready` is unchanged. The bundled metronome
  example is switched over. From ASTRID (Astrid, NetComposer-Synth PR #47).
- The 500 ms wait before the `currentTime − outputLatency` fallback now restarts after every real reading.
  Before, it was cleared only on a device or state change, so a later run of zero or placeholder stamps fell back
  at once.


### Added
- Device clock step handling in `AudioClockMapper`. A dropped or repeated output buffer moves the AudioContext clock
  against wall time by a whole buffer (~10 ms); the 9-sample median took 1–2 s to follow it. The mapper now
  re-anchors on a confirmed step. Options: `stepThresholdMs` (2, `0` = off), `stepConfirmations` (3) and
  `stepCheckMs` (50). New: `checkStep()`, `onStep(listener)` and `reanchors`. Zero output timestamps never count.
- `retimeForStep(when, step, renderedUntil)` and the `ClockStep` type, for schedulers that queue events ahead.
- Faster step confirmation: new option `stepConfirmMs` (10). Once a reading looks stepped, the confirming readings
  are taken that far apart instead of on the next periodic checks, so a step is confirmed ~20 ms after it is first
  seen instead of 100–150 ms. Each confirming reading must come from a new output timestamp (the same stamp read
  twice no longer counts twice), and placeholder stamps never count towards a step. `stepConfirmMs: 0` restores
  confirmation on the periodic checks. From ASTRID Rhythm (Petra).
- `examples/metronome` re-times queued clicks on a confirmed step (cancel and re-create every click not yet
  rendered), as the docs describe for queued schedulers.
- docs/nc-clock.md: "Device clock steps". Approach and constants from OLIVE Bass `clock-link` (Olive); patch by
  Petra (ASTRID Rhythm). Not a wire change.

### Fixed
- `examples/metronome`: queued clicks no longer drift off the grid when the audio clock runs fast or slow against
  wall time. A click kept the mapping of the moment it was queued, so with a long look-ahead (70 s, as a hidden tab
  test harness used) and ~83 ppm drift it ended up ~5 ms off. New `examples/metronome/retime-drift.js`:
  `retimeDrift()` runs on every ticker tick and moves any queued click more than 0.2 ms off the current mapping
  (cancel and re-create). New test `test/drift.test.ts` (83 ppm, 70 s look-ahead: max 6.18 ms without it, 0.58 ms
  with it). The library (`src/`) is unchanged. From ASTRID Rhythm (Petra).
- A follower's first note on join was sometimes 10–20 ms late. Right after a context starts, Chrome's
  `getOutputTimestamp()` gives placeholders (`contextTime` ~0.00002 s while `performanceTime` runs on, reading ~20
  then ~10 ms late), and a fresh `AudioClockMapper` took the first one as its offset. Stamps with `contextTime`
  below 3 ms are now ignored, `ready` needs three samples from distinct real stamps, and with the timestamp API but
  nothing real for 500 ms the mapper falls back to `currentTime − outputLatency`. From ASTRID (Astrid,
  NetComposer-Synth PR #47).

## [0.2.0] - 2026-10-27

Session swing over NC Sync, based on a contributed patch.

### Added
- `NcSyncPeer` option `swing: () => number | null`: the leader writes its swing into `state` (clamped to
  0.5–0.75; `null` sends 0, "unset").
- `peer.swing` (the session swing, or null until a leader sets one), `peer.onSwing(fn)` (fires on change only, never
  for unset), and `peer.publishState()` (leader resends `state`; returns false on a follower; 0.5.0 forwards it).
- `readSwing()`, `SWING_UNSET`, `SWING_STRAIGHT`, `SWING_MAX` in the protocol module.
- Spec (docs/nc-sync-v1.md §3): what `state.swing` means (position of the second 16th in each pair, 0.5 straight
  to 0.75), that `0` is unset, that receivers ignore out-of-range values, and that a leader may resend `state`.

### Changed
- Received `state.swing` is applied (0.1.0 ignored it and always sent 0). Still `nc-sync/1`: 0.1.0 peers keep
  working both ways, because their `0` now means "unset". The clock snapshot is unchanged (still version 1).

## [0.1.0] - 2026-10-27

First public version. nc-clock was created by [Peter Semmelhack](https://psem.me/).

### Added
- Pure core (AudioWorklet-safe, no DOM, timers, `performance` or `Date`): `TempoMap`, `Transport` (start/stop at a
  time, meter, bar position), `NcClock` with a `ClockAuthority` seam for external sync, and JSON snapshots
  (`toSnapshot`/`fromSnapshot`, format `nc-clock/snapshot` version 1, plus `shiftSnapshot`).
- Drift-free timing: every time is recomputed from the anchor (tested over 20,000 steps and across tempo changes).
- NC Sync v1 protocol types, validator (`parseMessage`) and spec (docs/nc-sync-v1.md).
- Browser adapters: `AudioClockMapper` (shared time ↔ AudioContext time with output latency), `createTicker`
  (Worker timer plus fallback), `NcSyncPeer` (BroadcastChannel, Web Locks leader election, `prefersLeader`).
- Example: a two-tab metronome (examples/metronome).
