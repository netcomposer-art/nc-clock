// Keep queued events on the current shared-time mapping while the audio clock drifts.
// nc-clock was created by Peter Semmelhack (https://psem.me/).
//
// An event is placed with the mapping of the moment it was queued. The audio clock and the shared clock drift apart
// (tens of ppm; about 83 ppm on a 2-core CI runner), so an event queued far ahead lands drift × look-ahead off the
// grid: 83 ppm × 60 s ≈ 5 ms. Call retimeDrift() on every ticker tick (the Worker ticker keeps ticking in a hidden
// tab) and re-create each event it returns at its new time.

/** Re-time an event once it is this far (s) off the current mapping. */
export const RETIME_S = 0.0002;
/** Leave events starting within this long (s) of `now` alone: they may already be rendering. */
export const RETIME_GUARD_S = 0.05;

/**
 * Removes from `queued` every event that starts at least `guard` after `now` and is at least `threshold` off
 * `target(event)` (its context time on the current mapping), and returns them with their new times. The caller
 * cancels each one (a started source cannot be moved) and queues it again at `when`.
 *
 * @template {{ when: number }} T
 * @param {T[]} queued events with `when` in context seconds; edited in place
 * @param {(event: T) => number} target the event's context time on the current mapping
 * @param {number} now the context's currentTime
 * @param {{ threshold?: number, guard?: number }} [options]
 * @returns {{ event: T, when: number }[]}
 */
export function retimeDrift(queued, target, now, { threshold = RETIME_S, guard = RETIME_GUARD_S } = {}) {
  const soon = now + guard;
  const moving = [];
  for (let i = 0; i < queued.length; i++) {
    const event = queued[i];
    if (event.when < soon) continue;
    const when = target(event);
    if (!Number.isFinite(when) || Math.abs(when - event.when) < threshold) continue;
    queued.splice(i, 1); i--;
    moving.push({ event, when });
  }
  return moving;
}
