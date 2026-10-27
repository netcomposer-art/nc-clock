# Contributing to nc-clock

Thanks for joining the party. nc-clock was created by [Peter Semmelhack](https://psem.me/); it grows with every app
that syncs to it.

## Ways to help

- **Build a peer.** Make your app (or a port in another language) speak NC Sync v1 and tell us in an issue. Peers
  in other languages don't need to live in this repo; link them from an issue and we'll list them.
- **Report timing bugs** with the browser, OS, audio device and a short recording or log if you can.
- **Improve docs and examples.**

## Development

```bash
npm ci
npm test            # compiles the tests and runs them with plain node (no browser needed)
npm run typecheck
npm run example     # the two-tab metronome at http://localhost:8080/examples/metronome/
```

Node 20 or newer. There are no runtime dependencies, and we'd like to keep it that way.

## Rules of the road

- **The core stays pure.** Nothing in `src/core` may touch `window`, `document`, `performance`, timers, `Worker`
  or `Date` (a test enforces this), so it keeps running in an AudioWorklet. Browser code goes in the adapters.
- **No running sums.** Times are always computed from the anchor.
- **Protocol changes** need an issue first. Additive, ignorable fields are fine within `nc-sync/1`; anything a v1
  peer would misread needs `nc-sync/2`. Update `docs/nc-sync-v1.md` and `CHANGELOG.md` in the same pull request.
- **JSDoc on every export**, and a test for every behaviour change.
- Add yourself to [AUTHORS](AUTHORS) in your first pull request. Please keep the credit in NOTICE intact.

By contributing you agree your contribution is licensed under the MIT License (see LICENSE), and to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
