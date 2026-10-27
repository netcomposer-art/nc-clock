/**
 * Browser adapter: map the shared NC Sync timeline to an AudioContext's time.
 *
 * Shared time is `(performance.timeOrigin + performance.now()) / 1000` seconds,
 * the same in every same-origin tab. `getOutputTimestamp()` pairs the context
 * time being *heard* with a performance time; the median of recent pairs gives
 * a steady offset. Not for worklets (uses `performance` and timers).
 *
 * @module
 */

/** The parts of an AudioContext the mapper reads (so tests can fake it). */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: string;
  readonly baseLatency?: number;
  readonly outputLatency?: number;
  getOutputTimestamp?(): { contextTime?: number; performanceTime?: number };
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

/** Options for {@link AudioClockMapper}. */
export interface AudioClockMapperOptions {
  /** Samples kept for the median. Default 9. */
  samples?: number;
  /** Sampling period while started (ms). Default 250. */
  intervalMs?: number;
  /** Re-read outputLatency at least this often (ms). Default 5000. */
  latencyIntervalMs?: number;
  /** Manual per-tab offset (ms, positive = later). Default 0. */
  userOffsetMs?: number;
  /** `performance.timeOrigin` (ms). Injected for tests. */
  timeOrigin?: number;
  /** `performance.now()` (ms). Injected for tests. */
  perfNow?: () => number;
}

/** Shared NC Sync time now, in seconds since the Unix epoch (`timeOrigin + now`). */
export function sharedNow(): number {
  return (performance.timeOrigin + performance.now()) / 1000;
}

/** Median of a non-empty list. */
export function median(values: readonly number[]): number {
  const s = values.slice().sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Keeps `contextTime ≈ sharedTime + offset`. Guards: ignores zero timestamps (before the
 * first rendered block), non-running contexts, and non-finite values; falls back to
 * `currentTime − outputLatency` where `getOutputTimestamp` is missing.
 *
 * @example
 * const mapper = new AudioClockMapper(ctx); mapper.start();
 * const when = mapper.toContextTime(beatTimeShared);   // schedule a note at `when`
 */
export class AudioClockMapper {
  private readonly ctx: AudioContextLike;
  private readonly keep: number;
  private readonly intervalMs: number;
  private readonly latencyIntervalMs: number;
  private readonly timeOrigin: number;
  private readonly perfNow: () => number;
  private offsets: number[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastLatencyRead = -Infinity;
  private latency: number | null = null;
  private readonly onSink = () => { this.offsets = []; this.readLatency(true); this.sample(); };
  /** Manual offset in ms (the ±250 ms per-tab slider). */
  userOffsetMs: number;

  /** Wrap a context. Call {@link start} to sample in the background, or {@link sample} yourself. */
  constructor(ctx: AudioContextLike, options: AudioClockMapperOptions = {}) {
    this.ctx = ctx;
    this.keep = Math.max(1, options.samples ?? 9);
    this.intervalMs = options.intervalMs ?? 250;
    this.latencyIntervalMs = options.latencyIntervalMs ?? 5000;
    this.userOffsetMs = options.userOffsetMs ?? 0;
    this.timeOrigin = options.timeOrigin ?? performance.timeOrigin;
    this.perfNow = options.perfNow ?? (() => performance.now());
  }

  /** Shared time now (seconds). */
  sharedNow(): number { return (this.timeOrigin + this.perfNow()) / 1000; }

  /** Take one sample. Returns false when the context can't give a trustworthy one yet. */
  sample(): boolean {
    const ctx = this.ctx;
    if (ctx.state !== 'running') return false;
    this.readLatency(false);
    let offset: number | null = null;
    const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    if (ts && Number.isFinite(ts.contextTime) && Number.isFinite(ts.performanceTime) && ts.contextTime! > 0 && ts.performanceTime! > 0) {
      offset = ts.contextTime! - (this.timeOrigin + ts.performanceTime!) / 1000;
    } else if (!ts || !(ts.contextTime! > 0)) {
      if (ctx.currentTime > 0) offset = ctx.currentTime - (this.latency ?? 0) - this.sharedNow();
    }
    if (offset === null || !Number.isFinite(offset)) return false;
    this.offsets.push(offset);
    if (this.offsets.length > this.keep) this.offsets.shift();
    return true;
  }

  /** True once at least one good sample exists. */
  get ready(): boolean { return this.offsets.length > 0; }

  /** contextTime − sharedTime (seconds), median of recent samples, plus the user offset. */
  get offset(): number {
    if (!this.offsets.length) this.sample();
    const base = this.offsets.length ? median(this.offsets) : this.ctx.currentTime - this.sharedNow();
    return base + this.userOffsetMs / 1000;
  }

  /** Shared time (s) → context time (s). */
  toContextTime(shared: number): number { return shared + this.offset; }
  /** Context time (s) → shared time (s). */
  toSharedTime(contextTime: number): number { return contextTime - this.offset; }

  /** Output latency in ms (outputLatency, else baseLatency), or null when the browser doesn't say. */
  get outputLatencyMs(): number | null { this.readLatency(false); return this.latency === null ? null : this.latency * 1000; }

  /** Sample every `intervalMs` and listen for output-device changes. */
  start(): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.ctx.addEventListener?.('sinkchange', this.onSink);
    this.ctx.addEventListener?.('statechange', this.onSink);
  }

  /** Stop background sampling. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ctx.removeEventListener?.('sinkchange', this.onSink);
    this.ctx.removeEventListener?.('statechange', this.onSink);
  }

  private readLatency(force: boolean): void {
    const now = this.perfNow();
    if (!force && now - this.lastLatencyRead < this.latencyIntervalMs) return;
    this.lastLatencyRead = now;
    const out = this.ctx.outputLatency, base = this.ctx.baseLatency;
    this.latency = Number.isFinite(out) && out! > 0 ? out! : Number.isFinite(base) && base! > 0 ? base! : null;
  }
}
