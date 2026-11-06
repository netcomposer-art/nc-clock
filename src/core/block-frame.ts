/**
 * The context frame an AudioWorklet render quantum really starts on.
 *
 * Under load Chrome sometimes hands `process()` the previous quantum's `currentFrame` (and `currentTime`) again,
 * once or a few times in a row, then the right one. The quanta themselves are distinct and back to back; only the
 * number is stale. A worklet that takes it at its word renders a block at the wrong place on the timeline: a step due
 * in it is missed (the window it looks at was the last block's), a step in the last block plays a second time, 128
 * frames late, and a ring indexed by frame overwrites the last block and leaves a hole.
 *
 * `BlockFrame` keeps its own count: each block starts where the last one ended (whole frames, so the count is exact
 * and never drifts). The reported frame is believed only on a real discontinuity:
 * - ahead of the count: the audio thread really skipped frames (this node was not pulled for a while);
 * - behind the count by more than `MAX_STALE_BLOCKS` blocks, or behind for more than `MAX_STALE_BLOCKS` blocks in a
 *   row: no stale report looks like that (Chrome repeats at most a few), so the count itself must be off.
 *
 * Allocation free and worklet safe (no DOM, no timers). One per processor; call `at` once per `process()`.
 */
export class BlockFrame {
  /** Stale reports longer than this many blocks (in a row, or in distance) are taken as a real discontinuity. */
  static readonly MAX_STALE_BLOCKS = 16;
  /**
   * [0] the frame the next block starts on (NaN before the first block), [1] stale blocks in a row,
   * [2] stale blocks seen, [3] resyncs (real discontinuities) seen. Typed, so per-block writes never box a double.
   */
  private readonly s = Float64Array.of(Number.NaN, 0, 0, 0);

  /**
   * The frame this block really starts on, given what the worklet reported (`currentFrame`) and the block's length
   * (`frames`, 128 in every browser today). Call once per `process()`, before anything reads the block's time.
   */
  at(reported: number, frames = 128): number {
    const s = this.s;
    const next = s[0] as number;
    let start = next;
    if (!(next === next) || reported > next) {
      // The first block, or frames really skipped: the reported frame is right.
      start = reported;
      if (next === next) s[3] = (s[3] as number) + 1;
      s[1] = 0;
    } else if (reported < next) {
      const run = (s[1] as number) + 1;
      if (run > BlockFrame.MAX_STALE_BLOCKS || next - reported > BlockFrame.MAX_STALE_BLOCKS * frames) {
        start = reported;
        s[1] = 0;
        s[3] = (s[3] as number) + 1;
      } else {
        s[1] = run;
        s[2] = (s[2] as number) + 1;
      }
    } else {
      s[1] = 0;
    }
    s[0] = start + frames;
    return start;
  }

  /**
   * The frame the next block will start on: "now" for code that runs between blocks (a port message). Before the
   * first block, `reported` (the worklet's `currentFrame` at that moment).
   */
  next(reported: number): number {
    const next = this.s[0] as number;
    return next === next ? next : reported;
  }

  /** Stale reports corrected so far (diagnostics). */
  get stale(): number {
    return this.s[2] as number;
  }

  /** Real discontinuities the count resynced on (diagnostics). */
  get resyncs(): number {
    return this.s[3] as number;
  }

  /** Forget the count: the next block believes its reported frame. */
  reset(): void {
    this.s[0] = Number.NaN;
    this.s[1] = 0;
  }
}
