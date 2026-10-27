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

## Example: a synth engine

A synth engine typically owns one `NcClock` on AudioContext time. Its note generator, arpeggiator and LFO grid all
read beat times from that one clock, so they can never disagree. On its own, the synth's Tempo knob, Play and Stop
drive the clock directly. When it joins NC Sync, an `NcSyncPeer` becomes the clock's authority and the synth
follows the leader, with no other changes to its scheduling code.

See the [README](../README.md) for the full API and [nc-sync-v1.md](nc-sync-v1.md) for the protocol.
