/**
 * Browser adapter: an NC Sync v1 peer over BroadcastChannel, with Web Lock
 * leader election (`prefersLeader` peers win). It is the {@link ClockAuthority}
 * for an {@link NcClock} on the shared timeline: local play/stop/tempo become
 * requests, the leader decides when they land, and every peer applies the
 * leader's `state` snapshot.
 *
 * @module
 */
import type { ClockAuthority, NcClock, StartRequest, StopRequest, TempoRequest } from './core/clock.js';
import { nextGridBeat } from './core/transport.js';
import {
  readSwing, SWING_MAX, SWING_STRAIGHT, SWING_UNSET, ANY_SLOT,
  DEFAULT_CAPABILITIES, DEFAULT_CHANNEL, LEADER_LOCK, envelope, parseMessage,
  type AudioReadiness, type Capabilities, type MessageBody, type NcSyncMessage, type SnapshotMessage, type StateMessage,
} from './protocol.js';

/** Minimal BroadcastChannel shape (so tests and other transports can stand in). */
export interface ChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

/** Minimal Web Locks shape. */
export interface LocksLike {
  request(name: string, options: { signal?: AbortSignal }, callback: (lock: unknown) => Promise<unknown>): Promise<unknown>;
}

/** What a peer knows about another peer. */
export interface PeerInfo {
  /** Instance id. */
  id: string;
  /** App name from `hello`. */
  app: string;
  /** Capabilities. */
  capabilities: Capabilities;
  /** Audio readiness. */
  audio: AudioReadiness;
  /** Tab hidden (heartbeats may be up to a minute apart). */
  hidden: boolean;
  /** Says it is the leader. */
  leader: boolean;
  /** Shared time it joined. */
  joinedAt: number;
  /** Shared time last heard from. */
  lastSeen: number;
  /** Output latency it reported (ms). */
  outputLatencyMs: number | null;
}

/** Options for {@link NcSyncPeer}. */
export interface NcSyncPeerOptions {
  /** App name, e.g. `"My Synth"`. */
  app: string;
  /** App version. */
  version: string;
  /** The clock this peer drives. Its times must be shared time (seconds since the epoch). */
  clock: NcClock;
  /** Capabilities (merged over the defaults). */
  capabilities?: Partial<Capabilities>;
  /** Channel name or object. Default `new BroadcastChannel("nc-sync")`. */
  channel?: string | ChannelLike;
  /** Web Locks; null forces "oldest peer leads". Default `navigator.locks` when present. */
  locks?: LocksLike | null;
  /** Shared time now (seconds). Default `(performance.timeOrigin + performance.now()) / 1000`. */
  now?: () => number;
  /** Instance id. Default random. */
  instanceId?: string;
  /** Current audio readiness. Default `'none'`. */
  audio?: () => AudioReadiness;
  /** Is this tab hidden? Default `document.visibilityState === 'hidden'`. */
  hidden?: () => boolean;
  /** Output latency to report (ms). */
  outputLatencyMs?: () => number | null;
  /**
   * This app's swing, written into `state` while it leads: where the second 16th of each pair lands, 0.5 (straight)
   * to 0.75. Values outside are clamped; `null`, `undefined` or NaN send "unset" (0). Omit it if your app has no swing.
   */
  swing?: () => number | null | undefined;
  /** Heartbeat period (ms). Default 1000. */
  heartbeatMs?: number;
  /** A visible peer is gone after this silence (ms). Default 3000. */
  peerTimeoutMs?: number;
  /** A hidden peer is gone after this silence (ms). Default 65000. */
  hiddenPeerTimeoutMs?: number;
  /** Lead time for a start when nothing plays (s). Default 0.2. */
  startLeadSeconds?: number;
  /** Least lead for any scheduled change (s). Default 0.1. */
  minLeadSeconds?: number;
  /** Without Web Locks: listen this long after joining before claiming the lead, so a newcomer learns who is
   * already there instead of briefly competing with the leader (ms). Default 300. */
  joinGraceMs?: number;
}

type Listener<T> = (value: T) => void;

/**
 * One NC Sync participant.
 *
 * @example
 * const clock = new NcClock({ timebase: 'shared' });
 * const peer = new NcSyncPeer({ app: 'My Drums', version: '1.0.0', clock, capabilities: { prefersLeader: true, sampleAccurate: true } });
 * await peer.start();          // joins; clock.play()/stop()/setTempo() are now requests
 * clock.onChange(() => reschedule());
 */
export class NcSyncPeer implements ClockAuthority {
  /** This instance's id. */
  readonly id: string;
  /** Current leader term. */
  term = 0;
  /** Other live peers by id. */
  readonly peers = new Map<string, PeerInfo>();
  private readonly o: Required<Omit<NcSyncPeerOptions, 'channel' | 'locks' | 'capabilities' | 'instanceId'>>;
  private readonly caps: Capabilities;
  private readonly clock: NcClock;
  private channel: ChannelLike | null = null;
  private readonly channelOption: string | ChannelLike;
  private readonly locks: LocksLike | null;
  private seq = 0;
  private lastSeq = new Map<string, number>();
  private leader = false;
  private joinedAt = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private grace: ReturnType<typeof setTimeout> | null = null;
  private releaseLock: (() => void) | null = null;
  private lockAbort: AbortController | null = null;
  private yielding = false;
  private stopAll = false;
  private roleListeners = new Set<Listener<'leader' | 'follower'>>();
  private peerListeners = new Set<Listener<PeerInfo[]>>();
  private snapshotListeners = new Set<Listener<SnapshotMessage>>();
  private messageListeners = new Set<Listener<NcSyncMessage>>();
  private swingListeners = new Set<Listener<number>>();
  private appliedSwing: number | null = null;

  /** Create a peer (not joined until {@link start}). */
  constructor(options: NcSyncPeerOptions) {
    const g = globalThis as { navigator?: { locks?: LocksLike }; document?: { visibilityState?: string }; crypto?: { randomUUID?: () => string }; performance?: Performance };
    this.clock = options.clock;
    this.caps = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
    this.channelOption = options.channel ?? DEFAULT_CHANNEL;
    this.locks = options.locks === undefined ? g.navigator?.locks ?? null : options.locks;
    this.id = options.instanceId ?? g.crypto?.randomUUID?.() ?? `p-${Math.random().toString(36).slice(2)}`;
    this.o = {
      app: options.app, version: options.version, clock: options.clock,
      now: options.now ?? (() => (g.performance!.timeOrigin + g.performance!.now()) / 1000),
      audio: options.audio ?? (() => 'none'),
      hidden: options.hidden ?? (() => g.document?.visibilityState === 'hidden'),
      outputLatencyMs: options.outputLatencyMs ?? (() => null),
      swing: options.swing ?? (() => null),
      heartbeatMs: options.heartbeatMs ?? 1000, peerTimeoutMs: options.peerTimeoutMs ?? 3000,
      hiddenPeerTimeoutMs: options.hiddenPeerTimeoutMs ?? 65000,
      startLeadSeconds: options.startLeadSeconds ?? 0.2, minLeadSeconds: options.minLeadSeconds ?? 0.1,
      joinGraceMs: options.joinGraceMs ?? 300,
    };
  }

  /** True while this peer leads. */
  get isLeader(): boolean { return this.leader; }
  /** This peer's capabilities. */
  get capabilities(): Capabilities { return { ...this.caps }; }

  /** Join: open the channel, take the clock's authority, say hello, and enter election. */
  async start(): Promise<void> {
    if (this.channel) return;
    this.channel = typeof this.channelOption === 'string' ? new BroadcastChannel(this.channelOption) as unknown as ChannelLike : this.channelOption;
    this.channel.onmessage = e => this.receive(e.data);
    this.joinedAt = this.o.now();
    this.clock.setAuthority(this);
    this.send({ type: 'hello', app: this.o.app, version: this.o.version, capabilities: this.caps, audio: this.o.audio(), outputLatencyMs: this.o.outputLatencyMs(), joinedAt: this.joinedAt });
    this.heartbeat = setInterval(() => this.beat(), this.o.heartbeatMs);
    if (this.locks) this.elect();
    else this.grace = setTimeout(() => { this.grace = null; this.elect(); }, this.o.joinGraceMs);
  }

  /** Leave: say bye, release the lock, give the clock back (standalone). */
  stop(): void {
    if (!this.channel) return;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.grace) clearTimeout(this.grace);
    this.grace = null;
    this.yielding = true;
    this.lockAbort?.abort(); this.lockAbort = null;
    this.releaseLock?.(); this.releaseLock = null;
    this.setLeader(false);
    this.send({ type: 'bye' });
    this.channel.onmessage = null;
    if (typeof this.channelOption === 'string') this.channel.close();
    this.channel = null;
    this.clock.setAuthority(null);
    this.peers.clear();
    this.lastSeq.clear();
  }

  /** Hear role changes. Returns an unsubscribe function. */
  onRole(listener: Listener<'leader' | 'follower'>): () => void { this.roleListeners.add(listener); return () => this.roleListeners.delete(listener); }
  /** Hear peer list changes. */
  onPeers(listener: Listener<PeerInfo[]>): () => void { this.peerListeners.add(listener); return () => this.peerListeners.delete(listener); }
  /** Hear snapshot slot actions from other peers. */
  onSnapshot(listener: Listener<SnapshotMessage>): () => void { this.snapshotListeners.add(listener); return () => this.snapshotListeners.delete(listener); }
  /** Hear every valid message from other peers (after dedupe). */
  onMessage(listener: Listener<NcSyncMessage>): () => void { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener); }
  /**
   * Hear the session swing change (0.5 to 0.75): from the leader's `state`, or this peer's own while it leads.
   * Fires only when the value changes, and never for "unset", so it is safe to feed it straight into your swing
   * control. Returns an unsubscribe function.
   */
  onSwing(listener: Listener<number>): () => void { this.swingListeners.add(listener); return () => this.swingListeners.delete(listener); }
  /** The session swing (0.5 to 0.75) from the latest `state` that set one, or null if no leader has set swing yet. */
  get swing(): number | null { return this.appliedSwing; }
  /**
   * Leader only: send `state` again now, e.g. after a swing edit when the transport did not change. Returns true
   * if it was sent, false on a follower (a follower's swing is local until the leader's next `state`).
   */
  publishState(): boolean { if (!this.leader || !this.channel) return false; this.broadcastState(); return true; }

  /**
   * Send a snapshot slot action (`recall` is idempotent; receivers never echo it). Returns the message's `seq`
   * (0 when the peer is not started), which a later {@link sendCancel} can name as `recallSeq`.
   */
  sendSnapshot(op: SnapshotMessage['op'], slot: number, extra: { atBeat?: number; glide?: SnapshotMessage['glide']; recallSeq?: number } = {}): number {
    return this.send({ type: 'snapshot', op, slot, ...extra });
  }
  /**
   * Withdraw this peer's pending `recall` (e.g. on Load or New), so followers that hold it don't switch on the bar
   * line. `slot` defaults to {@link ANY_SLOT}; pass `recallSeq` (from {@link sendSnapshot}) so the cancel can never
   * withdraw a newer recall. Peers older than this op drop it (and still switch). Returns the message's `seq`.
   */
  sendCancel(options: { slot?: number; recallSeq?: number } = {}): number {
    return this.send({ type: 'snapshot', op: 'cancel', slot: options.slot ?? ANY_SLOT,
      ...(options.recallSeq !== undefined ? { recallSeq: options.recallSeq } : {}) });
  }

  /** ClockAuthority: local Play. */
  requestStart(request: StartRequest): void {
    if (!this.leader && !this.knownLeader()) this.becomeLeaderIfAlone();
    if (this.leader) { this.decideStart(); return; }
    this.send({ type: 'transport', action: 'start', ...(request.beat !== undefined ? { atBeat: request.beat } : {}) });
  }
  /** ClockAuthority: local Stop. */
  requestStop(request: StopRequest): void {
    if (!this.leader && !this.knownLeader()) this.becomeLeaderIfAlone();
    if (this.leader) { this.decideStop(request.all ?? false); return; }
    this.send({ type: 'transport', action: 'stop', all: request.all ?? false });
  }
  /** ClockAuthority: local tempo change. */
  requestTempo(request: TempoRequest): void {
    if (!this.leader && !this.knownLeader()) this.becomeLeaderIfAlone();
    if (this.leader) { this.decideTempo(request.bpm, request.atBeat, request.rampBeats); return; }
    this.send({ type: 'tempo', bpm: request.bpm, ...(request.atBeat !== undefined ? { atBeat: request.atBeat } : {}), ...(request.rampBeats ? { rampBeats: request.rampBeats } : {}) });
  }

  // ---- leader decisions -------------------------------------------------------------
  private decideStart(): void {
    const t = this.clock.transport, now = this.o.now();
    if (t.isPlayingAt(now) && t.stopTime === null) {
      // Restart a running transport on the next bar line, from beat 0.
      const bar = t.nextBar(t.beatAt(now + this.o.minLeadSeconds));
      this.clock.commitStart(t.timeAt(bar), 0);
    } else {
      this.clock.commitStart(now + this.o.startLeadSeconds, 0);
    }
    this.broadcastState();
  }
  private decideStop(all: boolean): void {
    this.stopAll = all;
    this.clock.commitStop(this.o.now() + this.o.minLeadSeconds, all);
    this.broadcastState();
    this.stopAll = false;
  }
  private decideTempo(bpm: number, atBeat?: number, rampBeats?: number): void {
    const [lo, hi] = this.tempoRange();
    bpm = Math.min(hi, Math.max(lo, bpm));
    const t = this.clock.transport, now = this.o.now();
    if (!t.running) { this.clock.commitTempo(bpm); this.broadcastState(); return; }
    const earliest = t.beatAt(now + this.o.minLeadSeconds);
    const beat = Math.max(atBeat ?? nextGridBeat(earliest, 1), earliest);
    if (rampBeats && rampBeats > 0) { t.tempo.rampTempo(bpm, beat, rampBeats); this.clock.applySnapshot(this.clock.toSnapshot()); }
    else this.clock.commitTempo(bpm, beat);
    this.broadcastState();
  }
  /** Intersection of every live peer's tempo range with ours. */
  tempoRange(): [number, number] {
    let [lo, hi] = this.caps.tempoRange;
    for (const p of this.peers.values()) { lo = Math.max(lo, p.capabilities.tempoRange[0]); hi = Math.min(hi, p.capabilities.tempoRange[1]); }
    return lo <= hi ? [lo, hi] : this.caps.tempoRange;
  }
  private broadcastState(): void {
    if (!this.leader) return;
    const own = this.o.swing();
    const swing = typeof own === 'number' && Number.isFinite(own) ? Math.min(SWING_MAX, Math.max(SWING_STRAIGHT, own)) : SWING_UNSET;
    this.send({ type: 'state', clock: this.clock.toSnapshot(), swing, leaderApp: this.o.app, ...(this.stopAll ? { stopAll: true } : {}) });
    this.noteSwing(swing); // after sending, so a listener that republishes cannot reorder states
  }
  private noteSwing(value: unknown): void {
    const swing = readSwing(value);
    if (swing === null || swing === this.appliedSwing) return;
    this.appliedSwing = swing;
    for (const l of [...this.swingListeners]) l(swing);
  }

  // ---- receiving --------------------------------------------------------------------
  private receive(data: unknown): void {
    const m = parseMessage(data);
    if (!m || m.from === this.id) return;
    const last = this.lastSeq.get(m.from);
    if (last !== undefined && m.seq <= last) return;
    this.lastSeq.set(m.from, m.seq);
    if (m.term > this.term && m.type !== 'state') this.term = Math.max(this.term, m.term);
    switch (m.type) {
      case 'hello': case 'heartbeat': {
        const known = this.peers.has(m.from);
        this.peers.set(m.from, { id: m.from, app: m.app, capabilities: { ...DEFAULT_CAPABILITIES, ...m.capabilities }, audio: m.audio,
          hidden: m.type === 'heartbeat' ? m.hidden : false, leader: m.type === 'heartbeat' ? m.leader : false,
          joinedAt: m.joinedAt, lastSeen: this.o.now(), outputLatencyMs: m.outputLatencyMs });
        if (!known) this.emitPeers();
        // Answer a newcomer: the leader with the clock, everyone with a heartbeat (so it knows who is here).
        if (m.type === 'hello') { if (this.leader) this.broadcastState(); this.sendHeartbeat(); }
        this.elect();
        break;
      }
      case 'bye': this.peers.delete(m.from); this.lastSeq.delete(m.from); this.emitPeers(); this.elect(); break;
      case 'state': {
        if (m.term < this.term) return;
        if (this.leader) {
          // Two leaders (a handoff race): the newer term wins; on a tie the better-ranked peer keeps leading.
          if (m.term === this.term && this.outranks(m.from)) { this.broadcastState(); return; }
          this.setLeader(false);
        }
        this.term = m.term;
        for (const p of this.peers.values()) p.leader = p.id === m.from;
        const sender = this.peers.get(m.from);
        if (!sender) {
          this.peers.set(m.from, { id: m.from, app: m.leaderApp, capabilities: { ...DEFAULT_CAPABILITIES }, audio: 'none', hidden: false,
            leader: true, joinedAt: m.sentAt, lastSeen: this.o.now(), outputLatencyMs: null });
          this.emitPeers();
        } else sender.lastSeen = this.o.now();
        this.clock.applySnapshot(m.clock);
        this.noteSwing(m.swing);
        if (m.stopAll) this.clock.commitStop(m.clock.stopTime ?? this.o.now(), true);
        break;
      }
      case 'transport': if (this.leader) { if (m.action === 'start') this.decideStart(); else this.decideStop(m.all ?? false); } break;
      case 'tempo': if (this.leader) this.decideTempo(m.bpm, m.atBeat, m.rampBeats); break;
      case 'snapshot': for (const l of [...this.snapshotListeners]) l(m); break;
      case 'ping': this.send({ type: 'pong', id: m.id, receivedAt: this.o.now() }); break;
      default: break;
    }
    for (const l of [...this.messageListeners]) l(m);
  }

  // ---- election ---------------------------------------------------------------------
  /** A live peer that prefers leading while we don't: we should not lead. */
  private outranked(): boolean {
    if (!this.caps.canLead) return true;
    for (const p of this.peers.values()) {
      if (!p.capabilities.canLead) continue;
      if (p.capabilities.prefersLeader && !this.caps.prefersLeader) return true;
    }
    return false;
  }
  private elect(): void {
    if (!this.channel) return;
    const outranked = this.outranked();
    if (this.locks) {
      if (outranked) {
        this.yielding = true;
        this.lockAbort?.abort(); this.lockAbort = null;
        if (this.releaseLock) { const r = this.releaseLock; this.releaseLock = null; r(); }
        return;
      }
      this.yielding = false;
      if (this.releaseLock || this.lockAbort) return;
      const abort = new AbortController();
      this.lockAbort = abort;
      this.locks.request(LEADER_LOCK, { signal: abort.signal }, () => {
        this.lockAbort = null;
        if (!this.channel || this.yielding) return Promise.resolve();
        return new Promise<void>(resolve => {
          this.releaseLock = () => { this.setLeader(false); resolve(); };
          this.setLeader(true);
        });
      }).catch(() => { /* aborted */ }).finally(() => {
        if (this.lockAbort === abort) this.lockAbort = null;
        if (this.channel && !this.releaseLock && !this.lockAbort && !this.yielding) queueMicrotask(() => this.elect());
      });
      return;
    }
    if (this.grace) return; // still listening after joining
    // No Web Locks: the best eligible peer leads (prefersLeader, then oldest, then lowest id).
    const rank = (prefers: boolean, joinedAt: number, id: string) => [prefers ? 0 : 1, joinedAt, id] as const;
    let best = rank(this.caps.prefersLeader, this.joinedAt, this.id), bestId: string | null = this.caps.canLead ? this.id : null;
    for (const p of this.peers.values()) {
      if (!p.capabilities.canLead) continue;
      const r = rank(p.capabilities.prefersLeader, p.joinedAt, p.id);
      if (bestId === null || r[0] < best[0] || (r[0] === best[0] && (r[1] < best[1] || (r[1] === best[1] && r[2] < best[2])))) { best = r; bestId = p.id; }
    }
    this.setLeader(bestId === this.id);
  }
  /** Do we rank above peer `id` for leading (prefersLeader, then oldest, then lowest id)? */
  private outranks(id: string): boolean {
    const p = this.peers.get(id);
    if (!p) return this.id < id;
    const a = [this.caps.prefersLeader ? 0 : 1, this.joinedAt] as const, b = [p.capabilities.prefersLeader ? 0 : 1, p.joinedAt] as const;
    if (a[0] !== b[0]) return a[0] < b[0];
    if (a[1] !== b[1]) return a[1] < b[1];
    return this.id < id;
  }
  private knownLeader(): boolean { return [...this.peers.values()].some(p => p.leader); }
  private becomeLeaderIfAlone(): void { if (!this.peers.size && !this.locks && this.caps.canLead) this.setLeader(true); }
  private setLeader(on: boolean): void {
    if (on === this.leader) return;
    this.leader = on;
    if (on) { this.term += 1; this.broadcastState(); }
    for (const l of [...this.roleListeners]) l(on ? 'leader' : 'follower');
    this.beat();
  }

  // ---- housekeeping -----------------------------------------------------------------
  private beat(): void {
    if (!this.channel) return;
    const now = this.o.now();
    let changed = false;
    for (const p of [...this.peers.values()]) {
      const limit = (p.hidden ? this.o.hiddenPeerTimeoutMs : this.o.peerTimeoutMs) / 1000;
      if (now - p.lastSeen > limit) { this.peers.delete(p.id); this.lastSeq.delete(p.id); changed = true; }
    }
    if (changed) { this.emitPeers(); this.elect(); }
    this.sendHeartbeat();
  }
  private sendHeartbeat(): void {
    this.send({ type: 'heartbeat', app: this.o.app, leader: this.leader, audio: this.o.audio(), hidden: this.o.hidden(),
      outputLatencyMs: this.o.outputLatencyMs(), joinedAt: this.joinedAt, capabilities: this.caps });
  }
  private emitPeers(): void { const list = [...this.peers.values()]; for (const l of [...this.peerListeners]) l(list); }
  private send<M extends NcSyncMessage>(body: MessageBody<M> | Record<string, unknown>): number {
    if (!this.channel) return 0;
    this.channel.postMessage(envelope(body as MessageBody<M>, this.id, this.term, ++this.seq, this.o.now()));
    return this.seq;
  }
}
