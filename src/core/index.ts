/**
 * nc-clock core: pure beat/time math, safe in an AudioWorklet (no DOM, no
 * `performance`, no timers, no Worker). Import this entry inside worklets.
 *
 * @module
 */
export { TempoMap, clampBpm, type TempoPoint, type Anchor, type TempoMapOptions } from './tempo-map.js';
export { Transport, DEFAULT_METER, floorBeat, nextGridBeat, type Meter, type Position, type StartOptions, type StopOptions, type TransportOptions } from './transport.js';
export { SNAPSHOT_FORMAT, SNAPSHOT_VERSION, toSnapshot, fromSnapshot, applySnapshot, shiftSnapshot, validateSnapshot, type ClockSnapshot } from './snapshot.js';
export { NcClock, type ClockAuthority, type ClockChange, type StartRequest, type StopRequest, type TempoRequest, type NcClockOptions } from './clock.js';
/** Package version. */
export const NC_CLOCK_VERSION = '0.5.0';
