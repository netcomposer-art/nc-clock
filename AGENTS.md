# AGENTS.md: nc-clock

For AI agents (and people) working in this repo. [CONTRIBUTING.md](CONTRIBUTING.md) has the rules of the road; this
does not override them.

## What this is

`@netcomposer/nc-clock`: a universal beat clock for music apps, plus NC Sync v1, a small open protocol so separate
apps (tabs, windows, processes) play in time: one leader, everyone else follows its clock. Every NetComposer
instrument and the Studio run on it (each vendors a copy). TypeScript, no runtime dependencies. MIT; created by
Peter Semmelhack (keep the credit in NOTICE).

## Commands

```sh
npm ci
npm run typecheck
npm test            # compiles the tests and runs them with plain node (no browser)
npm run build       # tsc -> dist/
npm run example     # the two-tab metronome at http://localhost:8080/examples/metronome/
```

CI runs `npm ci`, typecheck, test, build on Node 20, 22 and 24.

## Rules

- **The core stays pure:** nothing in `src/core` touches `window`, `document`, `performance`, timers, `Worker` or
  `Date` (a test enforces it), so it runs in an AudioWorklet. Browser code goes in the adapters.
- **No running sums:** times are always computed from the anchor.
- **Protocol changes need an issue first.** Additive, ignorable fields are fine within `nc-sync/1`; anything a v1
  peer would misread needs `nc-sync/2`. Update `docs/nc-sync-v1.md` and `CHANGELOG.md` in the same pull request.
- JSDoc on every export, and a test for every behaviour change. No new runtime dependencies.
- **Vendoring:** apps copy this repo into `vendor/nc-clock/` (or `lib/nc-clock/`) at a pinned commit, with a
  `VENDORED_FROM` or `VENDORED.md` note. Change it here, then re-vendor; never edit a copy.
- Copy: short plain sentences. Commits and PRs need no attribution lines.

## Plugins

nc-clock has no plugins. NetComposer's insert effects are plugins of nc-fx: see
[docs/plugins.md](https://github.com/netcomposer-art/nc-fx/blob/main/docs/plugins.md) and
[netcomposer-art/nc-plugin-template](https://github.com/netcomposer-art/nc-plugin-template).

## Where to ask

Open an issue on [netcomposer-art/nc-clock](https://github.com/netcomposer-art/nc-clock/issues) (protocol changes
start there). Peter Semmelhack decides.
