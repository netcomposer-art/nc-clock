# nc-clock, explained simply

nc-clock was created by [Peter Semmelhack](https://psem.me/).

## The idea in one picture

Imagine a conductor who never waves a baton. Instead, before the music starts, she hands every musician the same
card:

> "Beat 0 is at 10:00:00.250. We play at 120 beats per minute. From beat 16 we play at 128."

With that card and a good watch, every musician can work out exactly when *any* beat happens, forever, without
looking up again. If the tempo changes, she hands out a new card. That card is the **clock snapshot**, the
conductor is the **leader**, and the musicians are your apps: the synth, the drums, and whatever comes next.

That is all nc-clock is:

1. **The card** (the clock): "beat B is at time T", plus tempo changes and the time signature.
2. **The arithmetic**: "when is beat 33.5?" and "what beat is it now?".
3. **The handing-out** (NC Sync): one app leads and shares its card; the others follow it.

## Why it doesn't drift

The old way to schedule notes: "next note = last note + 0.125 s". Each addition is off by a hair, and the hairs
pile up. After a few minutes, two apps doing that disagree audibly.

nc-clock never adds. Note 1,000 is computed fresh from the card: "beat 0 at T, so beat 250 is T + 250 × 0.5 s".
Note 20,000 is exactly as accurate as note 1. Two apps with the same card get the very same numbers.

## Why it works in hidden tabs

Browsers slow down timers in background tabs (to once a second, then once a minute) when the tab is silent.
nc-clock's ticker runs in a Web Worker, which browsers don't slow down, so the next notes are always scheduled in
time. The sounds themselves are scheduled ahead on the audio clock, which never slows down.

## Where it runs

The arithmetic part (the "core") doesn't touch the browser at all: you hand it times as plain numbers. So it runs
in a page, a Worker, an **AudioWorklet** (the audio thread, where many drum machines keep their
sequencer), in Node, or ported to another language.

## The pieces

| Piece | Job |
|---|---|
| `TempoMap` | The tempo card: anchor + tempo changes; beat ↔ time. |
| `Transport` | Start and stop at a time, meter, "which bar am I in". |
| `NcClock` | The transport plus a socket for an outside boss (an *authority*). Alone, Play plays. Synced, Play *asks* the leader. |
| Snapshot | The card as JSON (`toSnapshot()` / `fromSnapshot()`), to send to a Worker, a worklet or another app. |
| `AudioClockMapper` | Translates between the shared clock every tab agrees on and your app's audio clock, including speaker latency. |
| `createTicker` | A steady ~20 ms "check what to schedule" tick that survives background tabs. |
| `NcSyncPeer` | Joins the NC Sync channel, picks a leader, sends requests and applies the leader's card. |

## How a new destination joins (checklist)

1. **Run on the clock.** Replace "next note = last + step" with "next note = `clock.transport.timeAt(nextBeat)`",
   counting beats, not seconds. Keep your usual ~100–150 ms lookahead.
2. **Tick with `createTicker`** instead of `setInterval`, so a hidden tab keeps time.
3. **Join**: create the clock on shared time, an `AudioClockMapper` for your AudioContext, and an `NcSyncPeer`
   with your app name and capabilities (tempo range, whether you have swing, whether you'd like to lead).
4. **Convert at the last moment**: `mapper.toContextTime(clock.transport.timeAt(beat))` is when to start the sound.
5. **Listen**: `clock.onChange(...)`. A start, stop, tempo change or new card can arrive at any time; recompute your
   next beat from the clock (never from your own counters).
6. Done. Your Play, Stop and tempo controls now go through the leader automatically.

The metronome in `examples/metronome` does exactly this in about 100 lines.

## The first reading

Right after an AudioContext starts, Chrome's `getOutputTimestamp()` gives placeholders for the first two or three
output callbacks: `contextTime` stays at ~0.00002–0.00005 s while `performanceTime` already runs, so they read
~20 ms, then ~10 ms late. A note scheduled from one stays that late. `AudioClockMapper` ignores stamps with
`contextTime` below 3 ms, and `mapper.ready` turns true only after three samples from distinct real stamps
(single stamps jitter by up to ~2 ms under load). **Wait for `ready` before the first scheduling**: until then
`offset` is only a guess. `ready` is a plain read; to get there quickly, call `mapper.sampleIfNotReady()` from
a short retry loop (it takes a sample only when the output timestamp is new, and returns `ready`). The
background timer gets there too, every `intervalMs`. If a browser with the timestamp API gives nothing real for 500 ms, the mapper falls back
to `currentTime − outputLatency`, as it does where the API is missing.

## Device clock steps

A dropped or repeated output buffer moves the AudioContext clock against wall time by a whole buffer
(~10 ms) at once. The median of nine samples would take one to two seconds to follow it. That is a
10 ms error on every note in between, and it lasts longer in a hidden tab. While started,
`AudioClockMapper` checks every `stepCheckMs` (50 ms). A raw reading more than `stepThresholdMs` (2 ms)
from the median that agrees on `stepConfirmations` (3) consecutive checks re-anchors the mapper at once:
`offset` jumps by the step and `onStep(listener)` fires with `{ stepSeconds, confirmedAt, reanchors }`.
One-off `getOutputTimestamp` spikes are ignored. A reading with `contextTime` or `performanceTime` of 0
(a device glitch) never counts, so it can never confirm a step. Pass `stepThresholdMs: 0` to turn this off.

What happens to notes already scheduled when the step lands:

- **Snapshot schedulers** (a worklet that maps every render block from a posted clock snapshot): repost the
  snapshot in `onStep`. Every block after that is exact.
- **Queued schedulers** (events placed ahead in context time): re-time every event not yet rendered with
  `retimeForStep(when, step, ctx.currentTime + quantum)`, which adds the step. Events already handed to
  something that can't move (an `AudioBufferSourceNode.start(t)`) need cancel-and-restart if they fall
  after `confirmedAt`.
- **Either way**, a note rendered between the step and its confirmation (at most 3 × 50 ms, and at most
  the timer period in a hidden tab) is off by exactly the step. That is a bounded one-off error.
  `test/clock-steps.test.ts` shows all three cases with a simulated 10 ms step.

The approach and constants come from OLIVE Bass's `clock-link` (Olive, ASTRID-Bass PR #1), including
its test that zero timestamps never re-anchor.

## Example: a synth engine

A synth engine typically owns one `NcClock` on AudioContext time. Its note generator, arpeggiator and LFO grid all
read beat times from that one clock, so they can never disagree. On its own, the synth's Tempo knob, Play and Stop
drive the clock directly. When it joins NC Sync, an `NcSyncPeer` becomes the clock's authority and the synth
follows the leader, with no other changes to its scheduling code.

See the [README](../README.md) for the full API and [nc-sync-v1.md](nc-sync-v1.md) for the protocol.
