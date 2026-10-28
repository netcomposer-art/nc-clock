# Changelog

All notable changes to nc-clock are listed here. This project follows [Semantic Versioning](https://semver.org/).
The NC Sync protocol has its own major version (`proto: "nc-sync/1"`); see docs/nc-sync-v1.md.

## [0.4.0] - Unreleased

NC Sync `snapshot` op `cancel`. Wire compatible: receivers before 0.4.0 drop it. Not tagged or published yet: the
`v0.4.0` tag and the npm publish wait for Peter.

### Added
- NC Sync `snapshot` op `"cancel"`: withdraws the sender's own pending (held, not yet taken) `recall`, so followers
  don't switch on the bar line after the leader's Load or New dropped the queued slot. Optional `recallSeq` names the
  recall, so a stale cancel can't withdraw a newer one; `slot` is the recall's slot or `ANY_SLOT` (`-1`). A cancel
  after the recall was taken is a no-op. `NcSyncPeer.sendCancel({ slot?, recallSeq? })`; `cancelsRecall(cancel,
  recall)` is the matching rule (allocation-free); `ANY_SLOT`, `SNAPSHOT_OPS`. Spec: docs/nc-sync-v1.md, section 3,
  "cancel", including the unknown-op rule (receivers MUST drop and MUST NOT act on a snapshot op they don't know;
  a new op MUST be safe to ignore). From Rhythm's queued-slot audit (Petra; Bass #7, Olive); reviewed by Astrid.

### Changed
- `NcSyncPeer.sendSnapshot` returns the `seq` it sent (was `void`; 0 when the peer isn't started), so a cancel can
  name its recall. It throws a `TypeError` for `op: 'cancel'` or a `recallSeq` (use `sendCancel`) and for a slot
  that isn't an integer ≥ 0. `sendCancel` throws for a slot that isn't `ANY_SLOT` or an integer ≥ 0 and for a
  `recallSeq` this peer can't have sent; `recallSeq: 0` (a recall that was never sent) sends nothing.
- `parseMessage` checks snapshot ops against `SNAPSHOT_OPS`, requires an integer `slot` (≥ 0, or `-1` on `cancel`)
  and, on `cancel`, a `recallSeq` that is an integer ≥ 1 below the cancel's own `seq`. A recall with a negative or
  fractional slot is now dropped (receivers before 0.4.0 passed it on).
- docs/nc-sync-v1.md: "pending" covers recalls held to the receiver's next bar (no `atBeat`); a held recall is kept
  when its sender leaves; a sender whose `seq` restarts must use a new `from`. The `instanceId` option says the same.

### Migration (consumers)
Backward compatible on the wire, not for every listener or type:
- `onSnapshot` / `onMessage` now deliver `op: 'cancel'` with `slot: -1` (before, `parseMessage` filtered it out).
  A listener must check `op`: one that treats anything other than `store` as a recall would recall slot -1. An
  exhaustive `switch (m.op)` needs a `'cancel'` case. Rhythm, Bass and ASTRID all check `op === 'recall'` (or don't
  listen), so none breaks.
- `SnapshotMessage['op']` widened to include `'cancel'`; `sendSnapshot`'s `op` parameter excludes it.
- `sendSnapshot` returns `number`: a typed fake such as `Pick<NcSyncPeer, 'sendSnapshot'>` returning `void`, or an
  expression-bodied arrow annotated `: void` that returns the call, no longer compiles. Plain calls are unaffected.

## [0.3.0] - 2026-10-27 (f509605; not yet tagged or published)

Device clock step handling (with transient blips), a correct first reading for `AudioClockMapper`, and the
replaying `NcClock.subscribe`. **Breaking:** `ready` no longer
takes a sample (see Changed and the migration note).

The release every app vendors as "0.3.0 @ f509605". Tagging f509605 as `v0.3.0` and the npm publish wait for
Peter. Notes and tests that compare against "0.3.0" before f509605 mean the pre-release at b753634.

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
- `AudioClockMapper` treats a step that comes back within `stepRevertMs` (new option, default 200 ms of audio clock
  time, `0` = off) as a transient: the confirmed step is still applied at once (~20 ms confirmation unchanged),
  but provisionally; when the readings return to the pre-step anchor inside the window, that anchor is restored
  exactly, `reanchors` doesn't keep it, the new `reverts` counts it, and `onStep` fires with `revert: true`.
  From OLIVE Bass hidden-tab run 3 (Olive, ASTRID-Bass docs/sync-results.md).
- `NcClock.subscribe(listener)`: a replaying subscription. It calls the listener at once with the current state
  (`{ kind: 'snapshot', snapshot, replay: true }`), then on every change, so a scheduler attached after Tap to join
  gets a clock on a steady device. `onChange` is unchanged (changes only, now documented). The `snapshot` change
  gains an optional `replay` flag. Pattern from Rhythm's and Bass's `SnapshotFeed` (Petra, Olive).

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
- `AudioClockMapper.sample()` keeps one sample per output timestamp. `start()` and the first `sampleIfNotReady()`
  in the same task read the same stamp, and it counted twice, so `ready` came after two real readings instead of
  three. Found by Olive (OLIVE Bass).
- A real output stamp that stays unchanged while the context runs (stuck) no longer leaves the mapper unready
  forever with that dedupe: after 500 ms (`STAMP_WAIT_MS`) on one unchanged stamp while not ready, it falls back to
  `currentTime − outputLatency`, as for placeholder stamps. Once ready, a stuck stamp keeps the anchor. (b753634
  counted the stuck stamp three times and was ready in three ticks.) Found in review (Zeta).
- `NcSyncPeer` forgets a peer's message sequence number when that peer times out (a tab closed without `bye`) and
  on `stop()`. Before, one entry (about 100 B) per closed tab stayed for the life of the page. Found in ASTRID's
  multi-tab crash soak (NetComposer-Synth fix/crash-soak 7ea28c8).
- `AudioClockMapper.stop()` also closes an open revert window and drops the pause record, so after a restart a
  reading back at an old anchor is a new step, not a revert of a window from before the stop. Found in review (Zeta).

### Migration (consumers)
Checked against OLIVE Bass `apps/bass/src/app/sync-clock.test.ts` (psemmelhack/ASTRID-Bass, branch
olive/bass-css-nc-clock at 7bad965, vitest). On the 0.3.0 pre-release (b753634) all 6 pass. Three of them rely on its behaviour; on this
release two fail and one passes but gets there later:
- "waits for the mapper to be ready (3 real stamps), then publishes an audio-time snapshot at once": it relied on
  the double-counted stamp (`start()` plus the first `sampleIfNotReady()` on the same stamp counted as two
  readings, so one more poll made three). One stamp is now one sample, so `ready` needs three distinct stamps: the
  first snapshot comes one poll later, at `2 × READY_POLL_MS` instead of `READY_POLL_MS`. Advance two polls (fails
  as written).
- "a listener added after attachAudio gets the current snapshot at once, even when nothing changes": its context
  gives one constant real stamp (`{ contextTime: 3, performanceTime: 1000 }`), a stuck stamp. b753634 counted it on
  every sampler tick and was ready in about three ticks. With one-sample-per-stamp alone it would never get ready;
  now it falls back to `currentTime − outputLatency` after `STAMP_WAIT_MS` (500 ms) on the unchanged stamp, so it
  is ready at ~500 ms and the offset comes from the fallback rather than the stamp. Passes as written (exactly at
  its `REPOST_MS × 2` = 500 ms advance, with no margin); give it a stamp that moves, or advance past 500 ms.
- "re-arms the ready wait when the mapper re-measures (statechange), and publishes when ready again": it dispatches
  `statechange` while the context stays `running`. b753634 re-measured on every statechange; now the samples are kept
  when the context clock kept pace, so `audioSnapshot()` stays non-null and there is no second snapshot (fails as
  written). To test the re-measure, go `suspended` (dispatch), advance wall time more than 10 ms without
  `currentTime` moving, then back to `running` (dispatch): the mapper re-measures, `ready` is false, and the ready
  poll publishes again. A `sinkchange` still always re-measures.
With the first and third changed as described, all 6 pass on this release (checked locally, nothing pushed to
Bass). Bass can also drop its own `measured` flag (`ready` now stays true across steps, including inside `onStep`) and its
`onSnapshot` replay (`NcClock.subscribe`).

## [0.2.0] - 2026-10-27

Session swing over NC Sync, based on a contributed patch.

### Added
- `NcSyncPeer` option `swing: () => number | null`: the leader writes its swing into `state` (clamped to
  0.5–0.75; `null` sends 0, "unset").
- `peer.swing` (the session swing, or null until a leader sets one), `peer.onSwing(fn)` (fires on change only, never
  for unset), and `peer.publishState()` (leader resends `state`; returns false on a follower).
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
