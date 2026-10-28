# Changelog

All notable changes to nc-clock are listed here. This project follows [Semantic Versioning](https://semver.org/).
The NC Sync protocol has its own major version (`proto: "nc-sync/1"`); see docs/nc-sync-v1.md.

## [Unreleased]

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
- README "Timing guarantee" and docs/nc-clock.md: the numeric gates are unchanged (re-mapped p95 ≤ 1 ms, max ≤ 3 ms,
  at most 1 beat over 3 ms per 10 minutes per tab). A confirmed excursion, including one that later reverts as a
  blip, counts as one clock event under that same one-off-beat allowance and adds no extra allowance.

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
