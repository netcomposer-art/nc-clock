/**
 * nc-clock: a universal beat clock and the NC Sync v1 protocol for music apps
 * that play in time together. Created by Peter Semmelhack (https://psem.me/).
 *
 * - `core`: pure beat/time math (also importable alone via `@netcomposer/nc-clock/core`, AudioWorklet-safe).
 * - `protocol`: NC Sync v1 message types and validator.
 * - Browser adapters: {@link AudioClockMapper}, {@link createTicker}, {@link NcSyncPeer}.
 *
 * @module
 */
export * from './core/index.js';
export * from './protocol.js';
export { AudioClockMapper, sharedNow, median, type AudioContextLike, type AudioClockMapperOptions } from './audio-mapper.js';
export { createTicker, type Ticker, type TickerOptions } from './ticker.js';
export { NcSyncPeer, type NcSyncPeerOptions, type PeerInfo, type ChannelLike, type LocksLike } from './peer.js';
