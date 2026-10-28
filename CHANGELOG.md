# Changelog

All notable changes to nc-clock are listed here. This project follows [Semantic Versioning](https://semver.org/).
The NC Sync protocol has its own major version (`proto: "nc-sync/1"`); see docs/nc-sync-v1.md.

## [Unreleased]

### Added
- Device clock step handling in `AudioClockMapper`. A dropped or repeated output buffer moves the AudioContext clock
  against wall time by a whole buffer (~10 ms); the 9-sample median took 1–2 s to follow it. The mapper now
  re-anchors on a confirmed step. Options: `stepThresholdMs` (2, `0` = off), `stepConfirmations` (3) and
  `stepCheckMs` (50). New: `checkStep()`, `onStep(listener)` and `reanchors`. Zero output timestamps never count.
- `retimeForStep(when, step, renderedUntil)` and the `ClockStep` type, for schedulers that queue events ahead.
- docs/nc-clock.md: "Device clock steps". Approach and constants from OLIVE Bass `clock-link` (Olive); patch by
  Petra (ASTRID Rhythm). Not a wire change.

### Fixed
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
