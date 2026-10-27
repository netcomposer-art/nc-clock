/**
 * JSON-safe snapshot of a transport: anchor, tempo map, meter and play state.
 *
 * Use it to `postMessage` a clock into an AudioWorklet, to carry it in NC Sync
 * `state` messages, or to save it. Round trips give identical beat and time answers.
 *
 * @module
 */
import type { Anchor, TempoPoint } from './tempo-map.js';
import { Transport, type Meter, type TransportOptions } from './transport.js';

/** Snapshot format id. */
export const SNAPSHOT_FORMAT = 'nc-clock/snapshot';
/** Snapshot format version. Readers accept the same major version and ignore unknown fields. */
export const SNAPSHOT_VERSION = 1;

/**
 * A transport as plain JSON (numbers, strings, booleans, null, arrays, objects).
 *
 * @example
 * {
 *   "format": "nc-clock/snapshot", "version": 1, "timebase": "shared",
 *   "anchor": { "beat": 0, "time": 1761580000.25 },
 *   "tempo": [{ "beat": 0, "bpm": 120 }, { "beat": 32, "bpm": 96 }],
 *   "meter": { "beatsPerBar": 4, "beatUnit": 4 },
 *   "playing": true, "startTime": 1761580000.25, "stopTime": null, "stoppedBeat": 0
 * }
 */
export interface ClockSnapshot {
  /** Always {@link SNAPSHOT_FORMAT}. */
  format: typeof SNAPSHOT_FORMAT;
  /** {@link SNAPSHOT_VERSION}. */
  version: number;
  /** Which timeline the times are on: `"shared"` (NC Sync, seconds since the Unix epoch) or a local name such as `"audio"`. */
  timebase: string;
  /** Beat pinned to a time. */
  anchor: Anchor;
  /** Tempo points, first at the anchor beat. */
  tempo: TempoPoint[];
  /** Meter. */
  meter: Meter;
  /** True when a run has started and no stop is scheduled. */
  playing: boolean;
  /** Start time of the current run, or null. */
  startTime: number | null;
  /** Scheduled stop time, or null. */
  stopTime: number | null;
  /** Beat held while stopped. */
  stoppedBeat: number;
}

/** Capture `transport` as a snapshot on `timebase` (default `"local"`). */
export function toSnapshot(transport: Transport, timebase = 'local'): ClockSnapshot {
  return {
    format: SNAPSHOT_FORMAT, version: SNAPSHOT_VERSION, timebase,
    anchor: transport.tempo.anchor, tempo: transport.tempo.points, meter: { ...transport.meter },
    playing: transport.running, startTime: transport.startTime, stopTime: transport.stopTime, stoppedBeat: transport.stoppedBeat,
  };
}

/** Overwrite `transport` with `snapshot`. Throws on an invalid snapshot. */
export function applySnapshot(transport: Transport, snapshot: ClockSnapshot): void {
  const s = validateSnapshot(snapshot);
  transport.tempo.reset(s.anchor, s.tempo);
  transport.meter = { ...s.meter };
  transport.startTime = s.startTime;
  transport.stopTime = s.stopTime;
  transport.stoppedBeat = s.stoppedBeat;
}

/** Build a new transport from `snapshot`. */
export function fromSnapshot(snapshot: ClockSnapshot, options: TransportOptions = {}): Transport {
  const t = new Transport(options);
  applySnapshot(t, snapshot);
  return t;
}

/**
 * Move a snapshot to another timeline: every time plus `offsetSeconds`.
 * NC Sync followers use this to turn the shared clock into AudioContext time.
 */
export function shiftSnapshot(snapshot: ClockSnapshot, offsetSeconds: number, timebase = snapshot.timebase): ClockSnapshot {
  const add = (t: number | null) => t === null ? null : t + offsetSeconds;
  return { ...snapshot, timebase, anchor: { beat: snapshot.anchor.beat, time: snapshot.anchor.time + offsetSeconds },
    tempo: snapshot.tempo.map(p => ({ ...p })), meter: { ...snapshot.meter },
    startTime: add(snapshot.startTime), stopTime: add(snapshot.stopTime) };
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown): v is number | null => v === null || num(v);

/** Check a value is a usable snapshot (right format, major version, finite numbers). Returns it typed, or throws. */
export function validateSnapshot(value: unknown): ClockSnapshot {
  const s = value as ClockSnapshot;
  const fail = (why: string): never => { throw new TypeError(`Invalid nc-clock snapshot: ${why}`); };
  if (!s || typeof s !== 'object') fail('not an object');
  if (s.format !== SNAPSHOT_FORMAT) fail('format');
  if (!num(s.version) || Math.floor(s.version) !== SNAPSHOT_VERSION) fail(`unsupported version ${String(s.version)}`);
  if (!s.anchor || !num(s.anchor.beat) || !num(s.anchor.time)) fail('anchor');
  if (!Array.isArray(s.tempo) || !s.tempo.length || !s.tempo.every(p => p && num(p.beat) && num(p.bpm) && p.bpm > 0)) fail('tempo');
  if (!s.meter || !num(s.meter.beatsPerBar) || s.meter.beatsPerBar < 1 || !num(s.meter.beatUnit)) fail('meter');
  if (!numOrNull(s.startTime) || !numOrNull(s.stopTime) || !num(s.stoppedBeat)) fail('transport times');
  return s;
}
