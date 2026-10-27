/**
 * Browser adapter: a steady tick for lookahead schedulers, also in hidden tabs.
 *
 * Chrome throttles main-thread timers in hidden, silent tabs to once a second
 * (later once a minute). Dedicated Worker timers aren't throttled that way, so
 * the ticker runs a tiny inline Worker and, as a fallback, a main-thread timer.
 * Ticks closer than half the interval are merged, so a visible tab still gets
 * about one tick per interval. Not for worklets.
 *
 * @module
 */

/** Options for {@link createTicker}. */
export interface TickerOptions {
  /** Tick period in ms. Default 20. */
  intervalMs?: number;
  /** Use a Worker: `'auto'` (browser main thread with Worker and Blob URLs), true or false. Default `'auto'`. */
  worker?: boolean | 'auto';
  /** Clock for merging ticks (ms). Default `performance.now`, else `Date.now`. */
  now?: () => number;
}

/** A running or stopped ticker. */
export interface Ticker {
  /** Start ticking (no-op when running). */
  start(): void;
  /** Stop ticking. */
  stop(): void;
  /** Stop and free the Worker. */
  dispose(): void;
  /** True while started. */
  readonly running: boolean;
  /** `'worker+timer'` when the Worker is in use, else `'timer'`. */
  readonly kind: 'worker+timer' | 'timer';
}

const WORKER_SOURCE = 'let t=null;onmessage=e=>{clearInterval(t);t=null;if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}';

function canUseWorker(): boolean {
  const g = globalThis as Record<string, unknown>;
  return typeof g.Worker === 'function' && typeof g.Blob === 'function' && typeof g.document === 'object'
    && typeof (g.URL as typeof URL | undefined)?.createObjectURL === 'function';
}

/**
 * Call `onTick` about every `intervalMs` while started.
 *
 * @example
 * const ticker = createTicker(() => engine.tick(), { intervalMs: 20 });
 * ticker.start();
 */
export function createTicker(onTick: () => void, options: TickerOptions = {}): Ticker {
  const intervalMs = options.intervalMs ?? 20;
  const now = options.now ?? (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now());
  let worker: Worker | null = null;
  let url: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let last = -Infinity;
  let running = false;
  const fire = () => {
    if (!running) return;
    const t = now();
    if (t - last < intervalMs / 2) return;
    last = t;
    onTick();
  };
  if (options.worker === true || (options.worker !== false && canUseWorker())) {
    try {
      url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = fire;
    } catch { worker = null; if (url) URL.revokeObjectURL(url); url = null; }
  }
  return {
    get running() { return running; },
    get kind() { return worker ? 'worker+timer' as const : 'timer' as const; },
    start() {
      if (running) return;
      running = true;
      timer = setInterval(fire, intervalMs);
      worker?.postMessage(intervalMs);
    },
    stop() {
      running = false;
      if (timer) clearInterval(timer);
      timer = null;
      worker?.postMessage(0);
    },
    dispose() {
      this.stop();
      worker?.terminate(); worker = null;
      if (url) URL.revokeObjectURL(url); url = null;
    },
  };
}
