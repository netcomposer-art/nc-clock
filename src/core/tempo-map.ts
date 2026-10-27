/**
 * Tempo map: which beat happens at which time, and back.
 *
 * Pure math. No DOM, no `performance`, no timers, so it runs in an AudioWorklet's
 * global scope. Time is a plain number of seconds on whatever timeline the caller
 * picks (an AudioContext's `currentTime`, or the shared NC Sync timeline).
 *
 * The map is an anchor (a beat at a time) plus tempo points `{beat, bpm}`.
 * Times for later points are always re-derived from the anchor, in the same
 * order with the same arithmetic, so two maps built from the same data give
 * bit-identical answers and nothing accumulates drift.
 *
 * @module
 */

/** A tempo that holds from `beat` until the next point. Constant tempo between points (no ramps). */
export interface TempoPoint {
  /** Beat where this tempo starts. */
  beat: number;
  /** Beats per minute from that beat on. */
  bpm: number;
}

/** A beat pinned to a time. */
export interface Anchor {
  /** Beat number (may be fractional or negative). */
  beat: number;
  /** Time in seconds on the caller's timeline. */
  time: number;
}

/** Options for {@link TempoMap}. */
export interface TempoMapOptions {
  /** Initial tempo. Default 120. */
  bpm?: number;
  /** Initial anchor. Default `{ beat: 0, time: 0 }`. */
  anchor?: Anchor;
  /** Lowest accepted tempo; lower values are clamped. Default 1. */
  minBpm?: number;
  /** Highest accepted tempo; higher values are clamped. Default 999. */
  maxBpm?: number;
  /** Most points kept; older ones are folded into the anchor. Default 4096. */
  maxPoints?: number;
}

interface Segment { beat: number; time: number; bpm: number }
const EPS = 1e-9;

/** Clamp `bpm` into `[min, max]`; non-finite values fall back to `fallback`. */
export function clampBpm(bpm: number, min: number, max: number, fallback = 120): number {
  if (!Number.isFinite(bpm)) return Math.min(max, Math.max(min, fallback));
  return Math.min(max, Math.max(min, bpm));
}

/**
 * Piecewise-constant tempo map anchored at a beat and a time.
 *
 * @example
 * const map = new TempoMap({ bpm: 120, anchor: { beat: 0, time: 10 } });
 * map.setTempoAt(90, 8);   // 90 bpm from beat 8
 * map.timeAt(8);           // 14
 * map.beatAt(14 + 60/90);  // 9
 */
export class TempoMap {
  /** Lowest accepted tempo. */
  readonly minBpm: number;
  /** Highest accepted tempo. */
  readonly maxBpm: number;
  private readonly maxPoints: number;
  private segs: Segment[];

  /** Create a map with one tempo from the anchor on. */
  constructor(options: TempoMapOptions = {}) {
    this.minBpm = options.minBpm ?? 1;
    this.maxBpm = options.maxBpm ?? 999;
    this.maxPoints = Math.max(2, options.maxPoints ?? 4096);
    const anchor = options.anchor ?? { beat: 0, time: 0 };
    this.segs = [{ beat: anchor.beat, time: anchor.time, bpm: this.clamp(options.bpm ?? 120) }];
  }

  /** The anchor: the first point's beat and time. */
  get anchor(): Anchor { return { beat: this.segs[0].beat, time: this.segs[0].time }; }

  /** All tempo points, oldest first. The first point is at the anchor beat. */
  get points(): TempoPoint[] { return this.segs.map(s => ({ beat: s.beat, bpm: s.bpm })); }

  /** Tempo of the last point (the tempo things end up at). */
  get bpm(): number { return this.segs[this.segs.length - 1].bpm; }

  /** Clamp a tempo into this map's range. */
  clamp(bpm: number): number { return clampBpm(bpm, this.minBpm, this.maxBpm, this.segs?.[this.segs.length - 1]?.bpm ?? 120); }

  /**
   * Replace the whole map: anchor plus points. Points before the anchor beat are dropped;
   * if none sits exactly at the anchor, the tempo in force there is used.
   */
  reset(anchor: Anchor, points: readonly TempoPoint[]): void {
    const sorted = points.filter(p => Number.isFinite(p.beat) && Number.isFinite(p.bpm)).slice().sort((a, b) => a.beat - b.beat);
    let first = sorted.length ? sorted[0].bpm : this.bpm;
    for (const p of sorted) if (p.beat <= anchor.beat + EPS) first = p.bpm;
    const segs: Segment[] = [{ beat: anchor.beat, time: anchor.time, bpm: this.clamp(first) }];
    for (const p of sorted) {
      if (p.beat <= anchor.beat + EPS) continue;
      const bpm = this.clamp(p.bpm);
      if (bpm === segs[segs.length - 1].bpm) continue;
      segs.push({ beat: p.beat, time: 0, bpm });
    }
    this.segs = segs;
    this.recompute(1);
  }

  /** Move the anchor to `anchor`, keeping one tempo (the current last tempo unless `bpm` is given). */
  restart(anchor: Anchor, bpm = this.bpm): void {
    this.segs = [{ beat: anchor.beat, time: anchor.time, bpm: this.clamp(bpm) }];
  }

  /**
   * Change tempo at `beat`. Points at or after `beat` are replaced. A beat at or before
   * the anchor re-tempos from the anchor (the anchor's time stays put).
   */
  setTempoAt(bpm: number, beat: number): void {
    bpm = this.clamp(bpm);
    if (!Number.isFinite(beat) || beat <= this.segs[0].beat + EPS) {
      this.segs = [{ ...this.segs[0], bpm }];
      return;
    }
    while (this.segs.length > 1 && this.segs[this.segs.length - 1].beat >= beat - EPS) this.segs.pop();
    if (this.segs[this.segs.length - 1].bpm === bpm) return;
    this.segs.push({ beat, time: 0, bpm });
    this.recompute(this.segs.length - 1);
    if (this.segs.length > this.maxPoints) this.prune(this.segs[this.segs.length - this.maxPoints].beat);
  }

  /**
   * Ramp from the tempo at `startBeat` to `toBpm` over `beats`, as small constant steps
   * of `stepBeats` (default 1/4 beat). Peers without ramp support see ordinary points.
   */
  rampTempo(toBpm: number, startBeat: number, beats: number, stepBeats = 0.25): void {
    const from = this.bpmAt(startBeat);
    if (!(beats > 0) || !(stepBeats > 0)) { this.setTempoAt(toBpm, startBeat); return; }
    const steps = Math.max(1, Math.round(beats / stepBeats));
    this.setTempoAt(from, startBeat);
    for (let i = 1; i <= steps; i++) this.setTempoAt(from + (toBpm - from) * i / steps, startBeat + (beats * (i - 1)) / steps);
  }

  /** Fold points that start at or before `beat` into the anchor (bounded memory; answers unchanged). */
  prune(beat: number): void {
    let k = 0;
    for (let i = 1; i < this.segs.length; i++) if (this.segs[i].beat <= beat) k = i;
    if (k > 0) this.segs = this.segs.slice(k);
  }

  /** Tempo in force at `beat`. */
  bpmAt(beat: number): number { return this.segAtBeat(beat).bpm; }

  /** Time (seconds) of `beat`. Beats before the anchor use the first tempo. */
  timeAt(beat: number): number {
    const s = this.segAtBeat(beat);
    return s.time + (beat - s.beat) * 60 / s.bpm;
  }

  /** Beat at `time` (seconds). Times before the anchor use the first tempo. */
  beatAt(time: number): number {
    const s = this.segAtTime(time);
    return s.beat + (time - s.time) * s.bpm / 60;
  }

  /** A deep copy. */
  clone(): TempoMap {
    const m = new TempoMap({ minBpm: this.minBpm, maxBpm: this.maxBpm, maxPoints: this.maxPoints });
    m.segs = this.segs.map(s => ({ ...s }));
    return m;
  }

  /** Shift every time by `seconds` (move the map to another timeline). Beats are unchanged. */
  shift(seconds: number): void {
    this.segs[0].time += seconds;
    this.recompute(1);
  }

  private recompute(from: number): void {
    for (let i = Math.max(1, from); i < this.segs.length; i++) {
      const p = this.segs[i - 1];
      this.segs[i].time = p.time + (this.segs[i].beat - p.beat) * 60 / p.bpm;
    }
  }
  private segAtBeat(beat: number): Segment {
    const segs = this.segs;
    for (let i = segs.length - 1; i > 0; i--) if (segs[i].beat <= beat + EPS) return segs[i];
    return segs[0];
  }
  private segAtTime(time: number): Segment {
    const segs = this.segs;
    for (let i = segs.length - 1; i > 0; i--) if (segs[i].time <= time + EPS) return segs[i];
    return segs[0];
  }
}
