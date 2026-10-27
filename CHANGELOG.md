# Changelog

All notable changes to nc-clock are listed here. This project follows [Semantic Versioning](https://semver.org/).
The NC Sync protocol has its own major version (`proto: "nc-sync/1"`); see docs/nc-sync-v1.md.

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
