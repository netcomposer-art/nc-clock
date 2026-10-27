/**
 * NcClock: a transport plus the seam where sync plugs in.
 *
 * Standalone (no authority), `play`/`stop`/`setTempo` apply at once. When an
 * authority is set (an NC Sync peer, or anything else that owns time), the same
 * calls become *requests*; the authority decides when they land and commits them
 * with {@link NcClock.applySnapshot}. Listeners hear about every committed change,
 * local or remote, so an instrument schedules from one place either way.
 *
 * Pure (AudioWorklet-safe).
 *
 * @module
 */
import { Transport, type Meter, type TransportOptions } from './transport.js';
import { applySnapshot, toSnapshot, type ClockSnapshot } from './snapshot.js';

/** A request to start. Times are seconds on the clock's timeline. */
export interface StartRequest {
  /** Preferred start time (the authority may move it, e.g. to the next bar). */
  at?: number;
  /** Beat to start from. */
  beat?: number;
  /** Tempo to start at. */
  bpm?: number;
}
/** A request to stop. */
export interface StopRequest {
  /** Preferred stop time. */
  at?: number;
  /** Also stop free-running parts (latched arps, locked sequences). NC Sync `all`. */
  all?: boolean;
}
/** A request to change tempo. */
export interface TempoRequest {
  /** New tempo. */
  bpm: number;
  /** Beat it should land on (default: the authority picks). */
  atBeat?: number;
  /** Ramp length in beats (optional; peers may ignore). */
  rampBeats?: number;
}

/**
 * Something that owns time: it receives requests and later commits state with
 * {@link NcClock.applySnapshot}. The NC Sync peer is one; tests use fakes.
 */
export interface ClockAuthority {
  /** Local Play pressed. */
  requestStart(request: StartRequest): void;
  /** Local Stop pressed. */
  requestStop(request: StopRequest): void;
  /** Local tempo changed. */
  requestTempo(request: TempoRequest): void;
}

/** What changed, for listeners. */
export type ClockChange =
  | { kind: 'start'; at: number; beat: number }
  | { kind: 'stop'; at: number; all: boolean }
  | { kind: 'tempo'; atBeat: number; bpm: number }
  | { kind: 'snapshot'; snapshot: ClockSnapshot };

/** Options for {@link NcClock}. */
export interface NcClockOptions extends TransportOptions {
  /** Label for snapshots' `timebase`. Default `"local"`. */
  timebase?: string;
}

/**
 * The clock an instrument schedules from.
 *
 * @example
 * const clock = new NcClock({ bpm: 120, minBpm: 20, maxBpm: 240, timebase: 'audio' });
 * clock.onChange(change => scheduler.replan(change));
 * clock.play({ at: ctx.currentTime + 0.008 });       // standalone: starts now
 * clock.setAuthority(syncPeer);                       // synced: play() now asks the leader
 */
export class NcClock {
  /** The transport (read beats and times from here). */
  readonly transport: Transport;
  /** Snapshot timebase label. */
  readonly timebase: string;
  private authority: ClockAuthority | null = null;
  private listeners = new Set<(change: ClockChange) => void>();

  /** Create a stopped clock. */
  constructor(options: NcClockOptions = {}) {
    this.transport = new Transport(options);
    this.timebase = options.timebase ?? 'local';
  }

  /** True when an authority owns time (local calls are requests). */
  get external(): boolean { return this.authority !== null; }

  /** Hand time to `authority` (null: back to standalone). */
  setAuthority(authority: ClockAuthority | null): void { this.authority = authority; }

  /** Listen to committed changes. Returns an unsubscribe function. */
  onChange(listener: (change: ClockChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Start. Standalone: starts at `request.at` (required) from `request.beat` (default 0) and
   * returns true. External: forwards to the authority and returns false (nothing changed yet).
   */
  play(request: StartRequest & { at: number }): boolean {
    if (this.authority) { this.authority.requestStart(request); return false; }
    this.commitStart(request.at, request.beat ?? 0, request.bpm);
    return true;
  }

  /** Stop. Standalone: stops at `request.at` and returns true. External: forwards, returns false. */
  stop(request: StopRequest & { at: number }): boolean {
    if (this.authority) { this.authority.requestStop(request); return false; }
    this.commitStop(request.at, request.all ?? false);
    return true;
  }

  /**
   * Change tempo. Standalone: lands on `atBeat` (or the whole map while stopped) and returns
   * true. External: forwards, returns false.
   */
  setTempo(request: TempoRequest): boolean {
    if (this.authority) { this.authority.requestTempo(request); return false; }
    this.commitTempo(request.bpm, request.atBeat);
    return true;
  }

  /** Set the meter (local only; in sync the leader's meter arrives in snapshots). */
  setMeter(meter: Meter): void { this.transport.meter = { ...meter }; }

  /** Commit a start (authorities call this; standalone `play` does too). */
  commitStart(at: number, beat = 0, bpm?: number): void {
    this.transport.start({ at, beat, bpm });
    this.emit({ kind: 'start', at, beat });
  }
  /** Commit a stop. */
  commitStop(at: number, all = false): void {
    this.transport.stop({ at });
    this.emit({ kind: 'stop', at, all });
  }
  /** Commit a tempo change. */
  commitTempo(bpm: number, atBeat?: number): void {
    const beat = this.transport.setTempo(bpm, atBeat);
    this.emit({ kind: 'tempo', atBeat: beat, bpm: this.transport.tempo.bpmAt(beat) });
  }

  /** Replace the whole state with an authoritative snapshot (e.g. from the NC Sync leader). */
  applySnapshot(snapshot: ClockSnapshot): void {
    applySnapshot(this.transport, snapshot);
    this.emit({ kind: 'snapshot', snapshot });
  }

  /** The current state as JSON-safe data. */
  toSnapshot(): ClockSnapshot { return toSnapshot(this.transport, this.timebase); }

  private emit(change: ClockChange): void {
    for (const l of [...this.listeners]) l(change);
  }
}
