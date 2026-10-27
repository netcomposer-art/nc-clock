/**
 * Transport: playing or stopped, where beat 0 is, and the tempo map.
 *
 * Pure math (AudioWorklet-safe). Start and stop are scheduled at a time, so
 * every peer can apply the same change at the same moment. Time is seconds on
 * the caller's timeline.
 *
 * @module
 */
import { TempoMap, type Anchor, type TempoPoint } from './tempo-map.js';

/** Time signature. NC Sync uses the leader's meter; default 4/4. */
export interface Meter {
  /** Beats in one bar (the top number). */
  beatsPerBar: number;
  /** Note value of one beat (the bottom number); informational. */
  beatUnit: number;
}

/** The default meter, 4/4. */
export const DEFAULT_METER: Readonly<Meter> = Object.freeze({ beatsPerBar: 4, beatUnit: 4 });

/** Where a beat falls in bars. Bars and beats count from 0. */
export interface Position {
  /** The beat (unchanged). */
  beat: number;
  /** Bar number, from 0 (negative before beat 0). */
  bar: number;
  /** Beat within the bar, 0 ≤ beatInBar < beatsPerBar (fractional). */
  beatInBar: number;
  /** 0…1 progress through the bar. */
  barPhase: number;
}

/** Start the transport at a time, from a beat. */
export interface StartOptions {
  /** When beat `beat` sounds (seconds). */
  at: number;
  /** Beat to start from. Default 0. */
  beat?: number;
  /** Tempo to start at. Default: the current tempo. */
  bpm?: number;
}

/** Stop the transport at a time. */
export interface StopOptions {
  /** When to stop (seconds). */
  at: number;
}

/** Options for {@link Transport}. */
export interface TransportOptions {
  /** Initial tempo. Default 120. */
  bpm?: number;
  /** Meter. Default 4/4. */
  meter?: Meter;
  /** Lowest tempo. Default 1. */
  minBpm?: number;
  /** Highest tempo. Default 999. */
  maxBpm?: number;
}

const EPS = 1e-9;

/** Floor with a tiny tolerance so 3.9999999999 counts as 4. */
export function floorBeat(beat: number): number { return Math.floor(beat + EPS); }

/** First multiple of `grid` beats at or after `beat` (`strict`: after). */
export function nextGridBeat(beat: number, grid: number, strict = false): number {
  if (!(grid > 0)) return beat;
  const k = Math.ceil(beat / grid - EPS);
  const b = k * grid;
  return strict && b <= beat + EPS ? b + grid : b;
}

/**
 * A transport. Before `start()` and after a stop has passed, `beatAt()` returns
 * the beat where it stopped; while playing it follows the tempo map.
 *
 * @example
 * const t = new Transport({ bpm: 120 });
 * t.start({ at: 5, beat: 0 });
 * t.beatAt(6);          // 2
 * t.setTempo(60, 4);    // 60 bpm from beat 4
 * t.stop({ at: 9 });
 */
export class Transport {
  /** The tempo map (beat ↔ time). */
  readonly tempo: TempoMap;
  /** Meter used for bars. */
  meter: Meter;
  /** Time the current run starts, or null while stopped. */
  startTime: number | null = null;
  /** Time the current run stops, or null when no stop is scheduled. */
  stopTime: number | null = null;
  /** Beat held while stopped. */
  stoppedBeat = 0;

  /** Create a stopped transport. */
  constructor(options: TransportOptions = {}) {
    this.tempo = new TempoMap({ bpm: options.bpm, minBpm: options.minBpm, maxBpm: options.maxBpm });
    this.meter = { ...(options.meter ?? DEFAULT_METER) };
  }

  /** Current (last) tempo. */
  get bpm(): number { return this.tempo.bpm; }

  /** True when a run has started and no stop is scheduled. Use {@link isPlayingAt} for a time. */
  get running(): boolean { return this.startTime !== null && this.stopTime === null; }

  /** Is the transport playing at `time`? */
  isPlayingAt(time: number): boolean {
    return this.startTime !== null && time >= this.startTime - EPS && (this.stopTime === null || time < this.stopTime - EPS);
  }

  /** Start at `at` from `beat` (default 0). Replaces any earlier run and tempo history. */
  start(options: StartOptions): void {
    const beat = options.beat ?? 0;
    this.tempo.restart({ beat, time: options.at }, options.bpm ?? this.tempo.bpm);
    this.startTime = options.at;
    this.stopTime = null;
    this.stoppedBeat = beat;
  }

  /** Stop at `at`. The beat there is kept as {@link stoppedBeat}. */
  stop(options: StopOptions): void {
    if (this.startTime === null) return;
    const at = Math.max(options.at, this.startTime);
    this.stoppedBeat = this.tempo.beatAt(at);
    this.stopTime = at;
  }

  /** Forget any run (stopped at `beat`, default 0). */
  reset(beat = 0): void { this.startTime = null; this.stopTime = null; this.stoppedBeat = beat; }

  /**
   * Change tempo from `atBeat` on. While stopped (or with no beat) the whole map takes the
   * new tempo. Returns the beat the change lands on.
   */
  setTempo(bpm: number, atBeat?: number): number {
    if (!this.running || atBeat === undefined) {
      const anchor = this.tempo.anchor;
      this.tempo.setTempoAt(bpm, anchor.beat);
      return anchor.beat;
    }
    this.tempo.setTempoAt(bpm, atBeat);
    return atBeat;
  }

  /** Beat at `time`. Frozen at {@link stoppedBeat} before a start and after a stop. */
  beatAt(time: number): number {
    if (this.startTime === null) return this.stoppedBeat;
    if (this.stopTime !== null && time >= this.stopTime - EPS) return this.stoppedBeat;
    return this.tempo.beatAt(time);
  }

  /** Time of `beat` on the current run's tempo map (also valid for future or past beats). */
  timeAt(beat: number): number { return this.tempo.timeAt(beat); }

  /** Bar position of `beat` using {@link meter}. */
  position(beat: number): Position {
    const n = Math.max(1, this.meter.beatsPerBar);
    const bar = floorBeat(beat / n);
    const beatInBar = Math.max(0, beat - bar * n);
    return { beat, bar, beatInBar, barPhase: beatInBar / n };
  }

  /** First bar line at or after `beat` (`strict`: after). */
  nextBar(beat: number, strict = false): number { return nextGridBeat(beat, Math.max(1, this.meter.beatsPerBar), strict); }

  /** Anchor of the tempo map. */
  get anchor(): Anchor { return this.tempo.anchor; }

  /** Tempo points. */
  get tempoPoints(): TempoPoint[] { return this.tempo.points; }
}
