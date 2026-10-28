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
  /**
   * Device clock step threshold (ms). A raw reading this far from the median, agreeing on
   * {@link stepConfirmations} consecutive checks, re-anchors at once. Default 2. `0` turns detection off.
   */
  stepThresholdMs?: number;
  /** Consecutive agreeing readings that confirm a step. Default 3 (one-off spikes are ignored). */
  stepConfirmations?: number;
  /** Step check period while started (ms). Default 50: a step is first seen at most ~50 ms after it reaches the output. */
  stepCheckMs?: number;
  /**
   * Follow-up delay (ms) while a step is pending and the mapper is started: the confirming readings are taken this
   * far apart instead of on the next periodic checks. Default 10 (about one output callback), so a step is confirmed
   * ~20–30 ms after it is first seen instead of 100–150 ms. Each confirmation needs a new output timestamp
   * (`contextTime` must change). `0` keeps confirmations on the periodic checks.
   */
  stepConfirmMs?: number;
  /**
   * Revert window (ms of audio clock time). A confirmed step is applied at once, but provisionally: if the readings
   * come back to the anchor from before it (within `stepThresholdMs`, confirmed like a step) within this window, it
   * was a transient, not a device clock step. The mapper then restores that anchor exactly (all its samples), counts
   * no lasting re-anchor, and `onStep` fires with `revert: true`. Default 200. `0` turns it off (every confirmed
   * step is final, as in 0.3.0).
   */
  stepRevertMs?: number;
}

/** A confirmed device clock step, as handed to {@link AudioClockMapper.onStep} listeners. */
export interface ClockStep {
  /** New offset − old offset (s). Positive: contextTime jumped ahead of wall time (a dropped buffer). */
  stepSeconds: number;
  /** `ctx.currentTime` when the step was confirmed. Anything rendered before this is already heard. */
  confirmedAt: number;
  /** Lasting re-anchors since construction, after this event (a revert takes back the steps it undoes). */
  reanchors: number;
  /**
   * True when this event takes back a provisional step (a transient that returned within `stepRevertMs`): the
   * mapping is back on the anchor it had before that step, and `stepSeconds` moves events back to it. Always set
   * by the mapper; optional in the type so hand-made events (tests) still type-check.
   */
  revert?: boolean;
}

/**
 * Re-time one context-time event that was computed with the offset in force before `step`.
 * Not yet rendered (`when` later than `renderedUntil`, normally `ctx.currentTime` plus one render
 * quantum): it moves by the step and lands on the shared grid. Already rendered: it stays, and that
 * one event is off by `step.stepSeconds` (bounded by the step, at most the detection window long).
 */
export function retimeForStep(when: number, step: Pick<ClockStep, 'stepSeconds'>, renderedUntil: number): number {
  return when > renderedUntil ? when + step.stepSeconds : when;
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
 * Output timestamps with `contextTime` below this (s, about one render quantum) are placeholders: Chrome reports
 * contextTime ~0.00002–0.00005 s for the first two or three output callbacks after the context starts, while
 * performanceTime already runs, so they read ~20, then ~10 ms late.
 */
const MIN_STAMP = 0.003;
/**
 * Samples (from distinct output timestamps) before {@link AudioClockMapper.ready}: single real stamps still jitter
 * by up to ~2 ms (headless Chrome under load); the median of three drops one such reading.
 */
const READY_SAMPLES = 3;
/** How long (ms) to wait for a real output timestamp before falling back to `currentTime − latency`. */
const STAMP_WAIT_MS = 500;

/**
 * Keeps `contextTime ≈ sharedTime + offset`. Guards: ignores zero timestamps (before the
 * first rendered block), placeholder timestamps (contextTime below MIN_STAMP), non-running contexts, and
 * non-finite values; falls back to `currentTime − outputLatency` where `getOutputTimestamp` is missing (or
 * gives nothing real for STAMP_WAIT_MS, counted from the last real reading). Check {@link AudioClockMapper.ready}
 * (or call {@link AudioClockMapper.sampleIfNotReady}) before the first scheduling.
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
  private readonly onSink = () => { this.offsets.length = 0; this.revertUntil = -Infinity; this.clearPending(); this.waitSince = null; this.readLatency(true); this.sample(); };
  // When the timestamp had nothing real yet (zeros, or a placeholder below MIN_STAMP), since when (perfNow ms).
  private waitSince: number | null = null;
  private readyStamp: number | undefined = undefined;
  private readonly stepThreshold: number;
  private readonly stepConfirmations: number;
  private readonly stepCheckMs: number;
  private stepTimer: ReturnType<typeof setInterval> | null = null;
  private pendingStep: number | null = null;
  private pendingCount = 0;
  private pendingBack = false;
  private readonly stepConfirmMs: number;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  // contextTime of the last reading counted towards the pending step (the same stamp twice is one reading).
  private pendingStamp = 0;
  private stepCount = 0;
  private revertCount = 0;
  private readonly stepRevert: number;
  // The anchor before the first step of the open revert window: its samples, median and re-anchor count.
  private readonly preStep: number[] = [];
  private preStepBase = 0;
  private preStepCount = 0;
  // ctx.currentTime until which a reading back at the pre-step anchor reverts (-Infinity: no window open).
  private revertUntil = -Infinity;
  // Scratch for the median (no allocation on the step check or `offset` read).
  private readonly scratch: number[] = [];
  private readonly stepListeners = new Set<(step: ClockStep) => void>();
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
    this.stepThreshold = Math.max(0, options.stepThresholdMs ?? 2) / 1000;
    this.stepConfirmations = Math.max(1, options.stepConfirmations ?? 3);
    this.stepCheckMs = options.stepCheckMs ?? 50;
    this.stepConfirmMs = Math.max(0, options.stepConfirmMs ?? 10);
    this.stepRevert = Math.max(0, options.stepRevertMs ?? 200) / 1000;
  }

  /** Lasting device clock re-anchors so far (a reverted transient is not counted). */
  get reanchors(): number { return this.stepCount; }
  /** Provisional steps taken back so far because the readings returned within `stepRevertMs` (transients). */
  get reverts(): number { return this.revertCount; }

  /** Hear confirmed device clock steps (repost your snapshot, re-time queued events). Returns an unsubscribe. */
  onStep(listener: (step: ClockStep) => void): () => void { this.stepListeners.add(listener); return () => { this.stepListeners.delete(listener); }; }

  /**
   * One step check. A device clock step (a dropped or repeated output buffer moves contextTime against
   * wall time by a whole buffer, ~10 ms) would otherwise take the 9-sample median ~1–2 s to follow.
   * Only real output timestamps count: `contextTime` and `performanceTime` must both be > 0, so a
   * glitch reading (performanceTime 0, position frozen) never confirms a step. Returns true on a re-anchor.
   * Approach and constants from OLIVE Bass `clock-link` (Olive, ASTRID-Bass PR #1).
   */
  checkStep(): boolean {
    if (this.stepThreshold === 0 || this.ctx.state !== 'running' || !this.offsets.length) return false;
    const ts = typeof this.ctx.getOutputTimestamp === 'function' ? this.ctx.getOutputTimestamp() : null;
    const c = ts?.contextTime ?? 0, p = ts?.performanceTime ?? 0;
    // Placeholders (contextTime below MIN_STAMP) and glitch readings (performanceTime 0) never count.
    if (!(c >= MIN_STAMP && p > 0) || !Number.isFinite(c) || !Number.isFinite(p)) return false;
    const raw = c - (this.timeOrigin + p) / 1000;
    const base = this.median();
    const step = raw - base;
    // Inside a revert window: a reading back at the pre-step anchor (and nearer it than the current one) heads for
    // a revert. It needs the same confirmation as a step, but not a full threshold from the current median: the
    // periodic samples taken in the window pull that median part of the way back.
    const dPre = Math.abs(raw - this.preStepBase);
    const back = this.ctx.currentTime <= this.revertUntil && dPre <= this.stepThreshold && dPre < Math.abs(step);
    if (!back && Math.abs(step) <= this.stepThreshold) { this.clearPending(); return false; }
    if (this.pendingStep !== null && back === this.pendingBack && (back || Math.abs(step - this.pendingStep) < this.stepThreshold / 2)) {
      // The same output timestamp read again is not a second reading: look again shortly.
      if (c === this.pendingStamp) { this.followUp(); return false; }
      this.pendingStamp = c;
      if (++this.pendingCount < this.stepConfirmations) { this.followUp(); return false; }
      this.clearPending();
      return this.reanchor(raw, base, back);
    }
    this.pendingStep = step; this.pendingBack = back; this.pendingCount = 1; this.pendingStamp = c;
    if (this.stepConfirmations === 1) return this.checkStep();
    this.followUp();
    return false;
  }

  /**
   * Apply a confirmed step. Inside an open revert window, readings back at the pre-step anchor take the window's
   * steps back (restore that anchor's samples exactly); any other confirmed step re-anchors on `raw`. The first
   * step outside a window opens one (saving the anchor), later steps inside it don't extend it.
   */
  private reanchor(raw: number, base: number, back: boolean): boolean {
    const now = this.ctx.currentTime;
    const open = now <= this.revertUntil;
    let event: ClockStep;
    if (back && open) {
      const o = this.offsets, saved = this.preStep;
      o.length = 0;
      for (let i = 0; i < saved.length; i++) o.push(saved[i]);
      this.stepCount = this.preStepCount; this.revertCount++; this.revertUntil = -Infinity;
      event = { stepSeconds: this.preStepBase - base, confirmedAt: now, reanchors: this.stepCount, revert: true };
    } else {
      if (Math.abs(raw - base) <= this.stepThreshold) return false; // a revert whose window just closed: nothing to do
      if (!open) {
        const o = this.offsets, saved = this.preStep;
        saved.length = 0;
        for (let i = 0; i < o.length; i++) saved.push(o[i]);
        this.preStepBase = base; this.preStepCount = this.stepCount;
        this.revertUntil = this.stepRevert > 0 ? now + this.stepRevert : -Infinity;
      }
      this.offsets.length = 0; this.offsets.push(raw);
      this.stepCount++;
      event = { stepSeconds: raw - base, confirmedAt: now, reanchors: this.stepCount, revert: false };
    }
    for (const l of [...this.stepListeners]) l(event);
    return true;
  }

  /** Median of the kept samples, sorted in a reused scratch array (insertion sort; at most `samples` long). */
  private median(): number {
    const o = this.offsets, s = this.scratch, n = o.length;
    s.length = n;
    for (let i = 0; i < n; i++) {
      const v = o[i];
      let j = i - 1;
      while (j >= 0 && s[j] > v) { s[j + 1] = s[j]; j--; }
      s[j + 1] = v;
    }
    const m = n >> 1;
    return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /** While started, take the next confirming reading after stepConfirmMs instead of the next periodic check. */
  private followUp(): void {
    if (!this.stepTimer || this.stepConfirmMs === 0 || this.confirmTimer) return;
    this.confirmTimer = setTimeout(() => { this.confirmTimer = null; this.checkStep(); }, this.stepConfirmMs);
  }

  private clearPending(): void {
    this.pendingStep = null; this.pendingBack = false; this.pendingCount = 0; this.pendingStamp = 0;
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
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
    if (ts && Number.isFinite(ts.contextTime) && Number.isFinite(ts.performanceTime) && ts.contextTime! >= MIN_STAMP && ts.performanceTime! > 0) {
      offset = ts.contextTime! - (this.timeOrigin + ts.performanceTime!) / 1000;
      this.waitSince = null; // a real reading: a later run of non-real stamps waits STAMP_WAIT_MS afresh
    } else if (!ts || !(ts.contextTime! >= MIN_STAMP) && !(ts.contextTime! > 0 && !(ts.performanceTime! > 0))) {
      // No timestamp, or none real yet (zeros, or the placeholder Chrome gives for the first output callbacks:
      // contextTime ~0.00002 s while performanceTime runs on, ~20 then ~10 ms off). With a timestamp API, wait up
      // to STAMP_WAIT_MS for a real one before using currentTime − latency.
      if (ts) {
        const now = this.perfNow();
        if (this.waitSince === null) this.waitSince = now;
        if (now - this.waitSince < STAMP_WAIT_MS) return false;
      }
      if (ctx.currentTime > 0) offset = ctx.currentTime - (this.latency ?? 0) - this.sharedNow();
    }
    if (offset === null || !Number.isFinite(offset)) return false;
    this.offsets.push(offset);
    if (this.offsets.length > this.keep) this.offsets.shift();
    return true;
  }

  /**
   * True once READY_SAMPLES (3) good samples exist. Pure: reading it never samples (use {@link sampleIfNotReady}
   * to move it along). Until then {@link offset} is only a guess (`currentTime − now`, off by the output
   * latency): wait for `ready` before scheduling against it.
   */
  get ready(): boolean { return this.offsets.length >= Math.min(READY_SAMPLES, this.keep); }

  /**
   * While not {@link ready}: take one sample if the output timestamp is new since the last call (the same stamp
   * twice adds nothing to the median). Returns `ready`. Call it from a short retry loop before the first
   * scheduling; the background timer (every `intervalMs`) gets there too, only slower.
   */
  sampleIfNotReady(): boolean {
    if (this.ready) return true;
    const ts = typeof this.ctx.getOutputTimestamp === 'function' ? this.ctx.getOutputTimestamp() : null;
    const real = !!ts && ts.contextTime! >= MIN_STAMP && ts.performanceTime! > 0;
    if (!real || ts!.contextTime !== this.readyStamp) { this.readyStamp = real ? ts!.contextTime : undefined; this.sample(); }
    return this.ready;
  }

  /** contextTime − sharedTime (seconds), median of recent samples, plus the user offset. */
  get offset(): number {
    if (!this.offsets.length) this.sample();
    const base = this.offsets.length ? this.median() : this.ctx.currentTime - this.sharedNow();
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
    if (this.stepThreshold > 0) this.stepTimer = setInterval(() => this.checkStep(), this.stepCheckMs);
    this.ctx.addEventListener?.('sinkchange', this.onSink);
    this.ctx.addEventListener?.('statechange', this.onSink);
  }

  /** Stop background sampling. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.stepTimer) clearInterval(this.stepTimer);
    this.stepTimer = null;
    this.clearPending();
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
