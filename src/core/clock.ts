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
import { Transport, nextGridBeat, type Meter, type TransportOptions } from './transport.js';
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
  /**
   * True when this authority tracks the instrument's own play state apart from the shared transport (NC Sync
   * `independentStop`): then {@link NcClock.playing} is the instrument's own flag, set with
   * {@link NcClock.commitMember}, and Stop ends only this instrument. Absent or false: `playing` follows the transport.
   */
  readonly independentStop?: boolean;
}

/** What changed, for listeners. */
export type ClockChange =
  | { kind: 'start'; at: number; beat: number }
  | { kind: 'stop'; at: number; all: boolean }
  | { kind: 'tempo'; atBeat: number; bpm: number }
  | { kind: 'snapshot'; snapshot: ClockSnapshot; replay?: boolean }
  /**
   * This instrument started or stopped on its own while the shared transport carries on (see
   * {@link NcClock.playing}). `at` is when (the clock's timeline). Only an `independentStop` authority sends it.
   */
  | { kind: 'member'; playing: boolean; at: number };

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
  private memberPlaying = false;
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

  /**
   * Is this instrument playing? Standalone, or with an authority that does not track it, this is the transport's
   * `running`. With an `independentStop` authority (an NC Sync peer created with `independentStop: true`) it is the
   * instrument's own state: the shared transport (the session grid) can run while this instrument is stopped, so an
   * engine gates its sound and playhead on this, and reads positions from {@link transport} as before.
   */
  get playing(): boolean { return this.authority?.independentStop ? this.memberPlaying : this.transport.running; }

  /** Does this instrument sound at `time`: {@link playing} and the shared transport plays then. */
  isPlayingAt(time: number): boolean { return this.playing && this.transport.isPlayingAt(time); }

  /**
   * Where an instrument that starts at `time` joins a running transport: the first multiple of `gridBeats` at or
   * after the beat at `time` (default: the next whole beat), and when it sounds. Joining never moves the grid.
   */
  joinPoint(time: number, gridBeats = 1): { beat: number; time: number } {
    const beat = nextGridBeat(this.transport.beatAt(time), gridBeats) + 0; // + 0: never -0
    return { beat, time: this.transport.timeAt(beat) };
  }

  /**
   * Listen to committed changes from now on (nothing is replayed: a listener added on a steady clock hears nothing
   * until the next start, stop, tempo change or snapshot). Returns an unsubscribe function. Use {@link subscribe}
   * when the listener needs the current state too.
   */
  onChange(listener: (change: ClockChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Replaying subscription: `listener` is called at once with the current state as
   * `{ kind: 'snapshot', snapshot, replay: true }`, then with every committed change, exactly as {@link onChange}.
   * For a scheduler or worklet attached late (after Tap to join unlocks audio on a steady clock, when no change
   * will come). Returns an unsubscribe function.
   */
  subscribe(listener: (change: ClockChange) => void): () => void {
    const off = this.onChange(listener);
    listener({ kind: 'snapshot', snapshot: this.toSnapshot(), replay: true });
    return off;
  }

  /**
   * Start. Standalone: starts at `request.at` (required) from `request.beat` (default 0) and
   * returns true. External: forwards to the authority and returns false (nothing changed yet).
   */
  play(request: StartRequest & { at: number }): boolean {
    if (this.authority) { this.authority.requestStart(request); return false; }
    this.memberPlaying = true;
    this.commitStart(request.at, request.beat ?? 0, request.bpm);
    return true;
  }

  /** Stop. Standalone: stops at `request.at` and returns true. External: forwards, returns false. */
  stop(request: StopRequest & { at: number }): boolean {
    if (this.authority) { this.authority.requestStop(request); return false; }
    this.memberPlaying = false;
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

  /**
   * Commit this instrument's own play state (authorities call this; see {@link playing}). Emits a `member` change
   * when it changes; the shared transport is untouched.
   */
  commitMember(playing: boolean, at: number): void {
    if (playing === this.memberPlaying) return;
    this.memberPlaying = playing;
    this.emit({ kind: 'member', playing, at });
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
