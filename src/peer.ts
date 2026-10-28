/**
 * Browser adapter: an NC Sync v1 peer over BroadcastChannel, with Web Lock
 * leader election (`prefersLeader` peers win). It is the {@link ClockAuthority}
 * for an {@link NcClock} on the shared timeline: local play/stop/tempo become
 * requests, the leader decides when they land, and every peer applies the
 * leader's `state` snapshot.
 *
 * With `independentStop: true` (nc-clock 0.5.0) the shared transport is the
 * session grid and each instrument has its own play state on it: Play joins a
 * running grid (it never restarts it), Stop stops only this instrument, the
 * leader ends the session when the last instrument stops, and a stopped leader
 * hands the lead to a playing peer (same snapshot, next term, same swing).
 *
 * @module
 */
import type { ClockAuthority, NcClock, StartRequest, StopRequest, TempoRequest } from './core/clock.js';
import { nextGridBeat } from './core/transport.js';
import {
  readSwing, SWING_MAX, SWING_STRAIGHT, SWING_UNSET,
  DEFAULT_CAPABILITIES, DEFAULT_CHANNEL, LEADER_LOCK, envelope, parseMessage,
  type AudioReadiness, type Capabilities, type HeartbeatMessage, type MessageBody, type NcSyncMessage, type SnapshotMessage, type StateMessage,
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
  /** It has per-instrument Stop (`capabilities.independentStop`, nc-clock 0.5.0). */
  independentStop: boolean;
  /** Its own play state (`independentStop` peers), or null for an older peer, which plays whenever the session does. */
  playing: boolean | null;
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
  /**
   * Per-instrument Stop (nc-clock 0.5.0, NC Sync capability `independentStop`). Stop stops only this instrument and
   * Play joins a running session grid; {@link NcClock.playing} is then this instrument's own state, so the engine
   * must gate its sound and playhead on it (or on `member` changes). `clock.stop({ all: true })` is still a
   * session-wide stop. Default false: every Stop is a session stop, exactly as in 0.4.0 and earlier.
   */
  independentStop?: boolean;
  /** Heartbeat period (ms). Default 1000. The timer runs only while another peer is known (see `beating`). */
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
const sub = <T>(set: Set<Listener<T>>, l: Listener<T>) => { set.add(l); return () => { set.delete(l); }; };
/** Call every listener (a copy, so one may unsubscribe while called). */
const emit = <T>(set: Set<Listener<T>>, value: T) => { for (const l of [...set]) l(value); };
type Rank = [number, number, number, string];
/** Lexicographic: does rank `a` come before `b`? */
const before = (a: Rank, b: Rank): boolean => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number);
  return a[3] < b[3];
};

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
  private readonly o: Required<Omit<NcSyncPeerOptions, 'channel' | 'locks' | 'capabilities' | 'instanceId' | 'independentStop'>>;
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
  private stopWakeListeners: (() => void) | null = null;
  private lockAbort: AbortController | null = null;
  private yielding = false;
  /** Set while stop() runs: no election from a tab that is leaving. */
  private leaving = false;
  /** Leader: the pending session end came from the last instrument stopping (not a Stop for everyone). */
  private idleEnd = false;
  /** Session swing carried over a handoff until this app publishes its own (independentStop only). */
  private carriedSwing: number | null = null;
  /** A session swing edit (a follower's publishState) not yet seen in a `state`, and when it was sent. */
  private editSwing: number | null = null;
  private editAt = 0;
  private readonly indep: boolean;
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
    if (options.independentStop) this.caps.independentStop = true;
    this.indep = this.caps.independentStop === true;
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
  /** ClockAuthority: true when Stop is per instrument (the `independentStop` option). */
  get independentStop(): boolean { return this.indep; }
  /** This instrument's own play state (same as `clock.playing`). */
  get playing(): boolean { return this.clock.playing; }

  /** Join: open the channel, take the clock's authority, say hello, and enter election. */
  async start(): Promise<void> {
    if (this.channel) return;
    this.leaving = false; this.yielding = false;
    this.channel = typeof this.channelOption === 'string' ? new BroadcastChannel(this.channelOption) as unknown as ChannelLike : this.channelOption;
    this.channel.onmessage = e => this.receive(e.data);
    this.joinedAt = this.o.now();
    this.clock.setAuthority(this);
    this.send({ type: 'hello', app: this.o.app, version: this.o.version, capabilities: this.caps, audio: this.o.audio(), outputLatencyMs: this.o.outputLatencyMs(), joinedAt: this.joinedAt, ...this.memberField() });
    // Heartbeats only while another peer is here (syncHeartbeat): alone, nobody listens, and an idle page must
    // not wake every second. A newcomer still learns about us: everyone answers its `hello` with a heartbeat.
    this.listenForWake();
    if (this.locks) this.elect();
    else this.grace = setTimeout(() => { this.grace = null; this.elect(); }, this.o.joinGraceMs);
  }

  /** Leave: say bye, release the lock, give the clock back (standalone). */
  stop(): void {
    if (!this.channel) return;
    if (this.grace) clearTimeout(this.grace);
    this.grace = null;
    this.stopWakeListeners?.(); this.stopWakeListeners = null;
    this.leaving = true; // setLeader(false) beats once; that beat must not re-elect this tab
    this.yieldLock();
    this.setLeader(false);
    this.send({ type: 'bye' });
    this.channel.onmessage = null;
    if (typeof this.channelOption === 'string') this.channel.close();
    this.channel = null;
    this.clock.setAuthority(null);
    this.peers.clear();
    this.lastSeq.clear();
    this.syncHeartbeat(); // no channel now, so this stops the heartbeat timer
  }

  /** Hear role changes. Returns an unsubscribe function. */
  onRole(listener: Listener<'leader' | 'follower'>): () => void { return sub(this.roleListeners, listener); }
  /** Hear peer list changes. */
  onPeers(listener: Listener<PeerInfo[]>): () => void { return sub(this.peerListeners, listener); }
  /** Hear snapshot slot actions from other peers. */
  onSnapshot(listener: Listener<SnapshotMessage>): () => void { return sub(this.snapshotListeners, listener); }
  /** Hear every valid message from other peers (after dedupe). */
  onMessage(listener: Listener<NcSyncMessage>): () => void { return sub(this.messageListeners, listener); }
  /**
   * Hear the session swing change (0.5 to 0.75): from the leader's `state`, or this peer's own while it leads.
   * Fires only when the value changes, and never for "unset", so it is safe to feed it straight into your swing
   * control. Returns an unsubscribe function.
   */
  onSwing(listener: Listener<number>): () => void { return sub(this.swingListeners, listener); }
  /** The session swing (0.5 to 0.75) from the latest `state` that set one, or null if no leader has set swing yet. */
  get swing(): number | null { return this.appliedSwing; }
  /**
   * After a swing edit: the leader sends `state` again now; a follower sends its swing to the leader as a session
   * edit (in a `heartbeat`), so the edit reaches the session whoever leads. Returns false when not joined (or a
   * follower without a swing).
   */
  publishState(): boolean {
    if (!this.channel) return false;
    if (this.leader) { this.carriedSwing = this.editSwing = null; this.broadcastState(); return true; }
    const swing = readSwing(this.o.swing());
    if (swing === null) return false;
    this.editSwing = swing; this.editAt = this.o.now();
    this.sendHeartbeat(swing);
    return true;
  }

  /** Send a snapshot slot action (`recall` is idempotent; receivers never echo it). */
  sendSnapshot(op: SnapshotMessage['op'], slot: number, extra: { atBeat?: number; glide?: SnapshotMessage['glide'] } = {}): void {
    this.send({ type: 'snapshot', op, slot, ...extra });
  }

  /**
   * ClockAuthority: local Play. With `independentStop`, this instrument starts playing at once: on a running
   * session it joins the grid (no message to the leader, the grid never moves); otherwise it asks the leader to
   * start the session (or to keep it, when a session stop is still pending).
   */
  requestStart(request: StartRequest): void {
    this.becomeLeaderIfAlone();
    if (this.indep) {
      this.setMember(true, this.o.now());
      if (this.clock.transport.running) return; // Join on the shared grid
    }
    if (this.leader) { this.decideStart(); return; }
    this.send({ type: 'transport', action: 'start', atBeat: request.beat });
  }
  /**
   * ClockAuthority: local Stop. With `independentStop` (and no `all`) it stops only this instrument: a local state
   * change plus a heartbeat, no transport request. The leader ends the session once no instrument plays.
   * `all: true` is a session stop for everyone, as before. In a mixed session (any known peer without
   * `independentStop`) every Stop is a session stop for everyone again (without `all`), the 0.4.0 behaviour.
   */
  requestStop(request: StopRequest): void {
    this.becomeLeaderIfAlone();
    if (this.indep) {
      const now = this.o.now();
      this.setMember(false, Math.max(now, request.at ?? now));
      // Mixed session (a peer without independentStop is here): Stop is the session stop for everyone, as in 0.4.0
      // and earlier, but not `all` (no stopAll: free-running parts such as a latched arp keep their state). Decided
      // per Stop from the peers known now, so it follows the peer set as peers come and go.
      if (!request.all && !this.mixedSession()) return;
    }
    if (this.leader) { this.decideStop(request.all ?? false); return; }
    this.send({ type: 'transport', action: 'stop', all: request.all ?? false });
  }
  /** ClockAuthority: local tempo change. */
  requestTempo(request: TempoRequest): void {
    this.becomeLeaderIfAlone();
    if (this.leader) { this.decideTempo(request.bpm, request.atBeat, request.rampBeats); return; }
    this.send({ type: 'tempo', bpm: request.bpm, atBeat: request.atBeat, rampBeats: request.rampBeats });
  }

  // ---- leader decisions -------------------------------------------------------------
  private decideStart(): void {
    const t = this.clock.transport, now = this.o.now();
    this.idleEnd = false;
    // independentStop: the session grid never restarts, so a Play on a running session is a Join (answer with the
    // state), and a pending session end (the last instrument had just stopped) keeps the run going instead.
    // Otherwise a running transport restarts on the next bar line, from beat 0.
    if (this.indep && t.running) { /* Join */ }
    else if (this.indep && t.startTime !== null && t.stopTime !== null && now < t.stopTime) this.clock.applySnapshot({ ...this.clock.toSnapshot(), playing: true, stopTime: null });
    else this.clock.commitStart(!this.indep && t.isPlayingAt(now) && t.stopTime === null ? t.timeAt(t.nextBar(t.beatAt(now + this.o.minLeadSeconds))) : now + this.o.startLeadSeconds, 0);
    this.broadcastState();
  }
  /** A session stop for everyone: an older peer's Stop, or `all`. */
  private decideStop(all: boolean): void {
    const at = this.o.now() + this.o.minLeadSeconds;
    this.idleEnd = false;
    this.carriedSwing = null;
    this.clock.commitStop(at, all);
    this.broadcastState(all || undefined, this.indep || undefined);
    if (this.indep) { this.everyoneStopped(); this.setMember(false, at); }
  }
  /** Leader, independentStop: end the session when no instrument plays any more (older peers play while it runs). */
  private endSessionIfIdle(): void {
    if (!this.leader || !this.indep || !this.clock.transport.running || this.anyMemberPlaying()) return;
    this.carriedSwing = null;
    this.clock.commitStop(this.o.now() + this.o.minLeadSeconds, false);
    this.broadcastState();
    this.idleEnd = true;
  }
  /**
   * Leader: an instrument started playing while the last-stop end is still pending (it pressed Play on what it
   * saw as a running grid). Keep the run at once, without waiting for its start request: no follower plays the
   * old grid only to restart on a new one.
   */
  private keepRunForJoin(): void {
    const t = this.clock.transport;
    if (!this.leader || !this.indep || !this.idleEnd || t.startTime === null || t.stopTime === null || this.o.now() >= t.stopTime) return;
    this.decideStart();
  }
  private anyMemberPlaying(): boolean {
    if (this.clock.playing) return true;
    for (const p of this.peers.values()) if (!p.independentStop || p.playing === true) return true;
    return false;
  }
  /** A known peer lacks independentStop: Stop falls back to the session stop for everyone. */
  private mixedSession(): boolean {
    for (const p of this.peers.values()) if (!p.independentStop) return true;
    return false;
  }
  /** Does `p` play (for election)? Older peers play whenever the session runs. */
  private peerPlays(p: PeerInfo): boolean { return p.independentStop ? p.playing === true : this.clock.transport.running; }
  /** After a session stop for everyone: every instrument is stopped (their heartbeats confirm it). */
  private everyoneStopped(): void { for (const p of this.peers.values()) if (p.independentStop) p.playing = false; }
  /** This instrument's own play state changed: commit it locally, tell the others, re-run the election. */
  private setMember(playing: boolean, at: number): void {
    if (playing === this.clock.playing) return;
    this.clock.commitMember(playing, at);
    if (!this.channel) return;
    this.sendHeartbeat();
    this.elect();
    this.endSessionIfIdle();
  }
  private memberField(): { playing?: boolean } { return this.indep ? { playing: this.clock.playing } : {}; }
  private decideTempo(bpm: number, atBeat?: number, rampBeats?: number): void {
    const [lo, hi] = this.tempoRange();
    bpm = Math.min(hi, Math.max(lo, bpm));
    const t = this.clock.transport, now = this.o.now();
    const earliest = t.beatAt(now + this.o.minLeadSeconds);
    const beat = Math.max(atBeat ?? nextGridBeat(earliest, 1), earliest);
    if (!t.running) this.clock.commitTempo(bpm);
    else if (rampBeats && rampBeats > 0) { t.tempo.rampTempo(bpm, beat, rampBeats); this.clock.applySnapshot(this.clock.toSnapshot()); }
    else this.clock.commitTempo(bpm, beat);
    this.broadcastState();
  }
  /** Intersection of every live peer's tempo range with ours. */
  tempoRange(): [number, number] {
    let [lo, hi] = this.caps.tempoRange;
    for (const p of this.peers.values()) { lo = Math.max(lo, p.capabilities.tempoRange[0]); hi = Math.min(hi, p.capabilities.tempoRange[1]); }
    return lo <= hi ? [lo, hi] : this.caps.tempoRange;
  }
  /** Flags are true or undefined (receivers test them for truthiness; JSON transports drop undefined). */
  private broadcastState(stopAll?: true, endSession?: true): void {
    if (!this.leader) return;
    const own = this.o.swing();
    const swing = this.editSwing ?? this.carriedSwing ?? (Number.isFinite(own) ? Math.min(SWING_MAX, Math.max(SWING_STRAIGHT, own as number)) : SWING_UNSET);
    this.send({ type: 'state', clock: this.clock.toSnapshot(), swing, leaderApp: this.o.app,
      independentStop: this.indep || undefined, stopAll, endSession });
    this.noteSwing(swing); // after sending, so a listener that republishes cannot reorder states
  }
  private noteSwing(value: unknown): void {
    const swing = readSwing(value);
    if (swing === null || swing === this.appliedSwing) return;
    this.appliedSwing = swing;
    emit(this.swingListeners, swing);
  }

  // ---- receiving --------------------------------------------------------------------
  private receive(data: unknown): void {
    const m = parseMessage(data);
    if (!m || m.from === this.id) return;
    const last = this.lastSeq.get(m.from);
    if (last !== undefined && m.seq <= last) return;
    this.lastSeq.set(m.from, m.seq);
    if (m.term > this.term && m.type !== 'state') this.term = m.term;
    switch (m.type) {
      case 'hello': case 'heartbeat': {
        const prev = this.peers.get(m.from);
        const capabilities = { ...DEFAULT_CAPABILITIES, ...m.capabilities };
        const independentStop = capabilities.independentStop === true;
        const playing = independentStop ? m.playing === true : null;
        this.peers.set(m.from, { id: m.from, app: m.app, capabilities, audio: m.audio,
          hidden: (m as HeartbeatMessage).hidden === true, leader: (m as HeartbeatMessage).leader === true, // not in hello
          joinedAt: m.joinedAt, lastSeen: this.o.now(), outputLatencyMs: m.outputLatencyMs, independentStop, playing });
        const memberChanged = !prev || prev.playing !== playing;
        if (memberChanged) this.emitPeers();
        if (memberChanged && playing === true) this.keepRunForJoin();
        const edit = readSwing((m as HeartbeatMessage).swing); // heartbeat only
        if (edit !== null) { this.editSwing = edit; this.editAt = m.sentAt; if (this.leader) this.broadcastState(); }
        // Answer a newcomer: the leader with the clock, everyone with a heartbeat (so it knows who is here).
        if (m.type === 'hello') { if (this.leader) this.broadcastState(); this.sendHeartbeat(); }
        this.elect();
        if (memberChanged) this.endSessionIfIdle();
        break;
      }
      case 'bye': this.peers.delete(m.from); this.lastSeq.delete(m.from); this.emitPeers(); this.elect(); this.endSessionIfIdle(); break;
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
          const independentStop = m.independentStop === true;
          this.peers.set(m.from, { id: m.from, app: m.leaderApp, capabilities: { ...DEFAULT_CAPABILITIES, independentStop },
            audio: 'none', hidden: false, leader: true, joinedAt: m.sentAt, lastSeen: this.o.now(), outputLatencyMs: null,
            independentStop, playing: null });
          this.emitPeers();
        } else sender.lastSeen = this.o.now();
        const wasRunning = this.clock.transport.running;
        this.clock.applySnapshot(m.clock);
        this.noteSwing(m.swing);
        // A pending swing edit is done once a state carries it (or the leader has moved on since).
        if (this.editSwing !== null && (m.swing === this.editSwing || m.sentAt - this.editAt > 0.25)) this.editSwing = null;
        if (m.stopAll) this.clock.commitStop(m.clock.stopTime ?? this.o.now(), true);
        if (this.indep && !this.clock.transport.running) {
          if (!m.independentStop || m.endSession || m.stopAll) {
            // A session stop for everyone (an older leader's Stop, an older peer's, or `all`): this instrument stops too.
            this.everyoneStopped();
            this.setMember(false, m.clock.stopTime ?? this.o.now());
          } else if (this.clock.playing) {
            // The session ended just as this instrument joined it: ask the leader to keep (or restart) the run.
            this.send({ type: 'transport', action: 'start' });
          }
        }
        if (wasRunning !== this.clock.transport.running) this.elect(); // older peers' play state follows the session
        break;
      }
      case 'transport': if (this.leader) { if (m.action === 'start') this.decideStart(); else this.decideStop(m.all ?? false); } break;
      case 'tempo': if (this.leader) this.decideTempo(m.bpm, m.atBeat, m.rampBeats); break;
      case 'snapshot': emit(this.snapshotListeners, m); break;
      case 'ping': this.send({ type: 'pong', id: m.id, receivedAt: this.o.now() }); break;
      default: break;
    }
    emit(this.messageListeners, m);
  }

  // ---- election ---------------------------------------------------------------------
  /**
   * independentStop: a playing instrument outranks a stopped one, so a leader that stops hands the lead to a playing
   * peer. Only when every peer that can lead has independentStop: older peers rank by prefersLeader and age alone,
   * and a mixed session must agree on one leader, so it keeps that order (the stopped leader keeps leading; the
   * clock does not depend on the leader's own instrument).
   */
  private playRanked(): boolean {
    if (!this.indep) return false;
    for (const p of this.peers.values()) if (p.capabilities.canLead && !p.independentStop) return false;
    return true;
  }
  /**
   * Rank key for leading, lower first: [stopped while others may play, not prefersLeader, joinedAt]. Playing
   * counts only while the session runs: with no session, a Play is a start request to the current leader, and
   * moving the lead at that moment would drop the request (with Web Locks the new leader takes over later).
   */
  private playKey(plays: boolean): number { return !plays && this.clock.transport.running && this.playRanked() ? 1 : 0; }
  /** A live peer that should lead before us (with Web Locks, where the lock queue breaks ties). */
  private outranked(): boolean {
    if (!this.caps.canLead) return true;
    // [play key, prefersLeader] only: the lock queue stands in for age.
    const me = this.myRank();
    for (const p of this.peers.values()) {
      const r = this.peerRank(p);
      if (p.capabilities.canLead && (r[0] < me[0] || r[0] === me[0] && r[1] < me[1])) return true;
    }
    return false;
  }
  /** Leave the lock queue and give up the lock (if held). */
  private yieldLock(): void {
    this.yielding = true;
    this.lockAbort?.abort(); this.lockAbort = null;
    const r = this.releaseLock; this.releaseLock = null; r?.();
  }
  private elect(): void {
    if (!this.channel || this.leaving) return; // a leaving tab never re-elects itself
    const outranked = this.outranked();
    if (this.locks) {
      if (outranked) { this.yieldLock(); return; }
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
    // No Web Locks: the best eligible peer leads (independentStop: playing first; then prefersLeader, oldest, lowest id).
    let best = this.myRank(), bestId: string | null = this.caps.canLead ? this.id : null;
    for (const p of this.peers.values()) {
      const r = this.peerRank(p);
      if (p.capabilities.canLead && (bestId === null || before(r, best))) { best = r; bestId = p.id; }
    }
    this.setLeader(bestId === this.id);
  }
  private myRank(): Rank { return this.rank(this.clock.playing, this.caps, this.joinedAt, this.id); }
  private peerRank(p: PeerInfo): Rank { return this.rank(this.peerPlays(p), p.capabilities, p.joinedAt, p.id); }
  private rank(plays: boolean, caps: Capabilities, joinedAt: number, id: string): Rank {
    return [this.playKey(plays), caps.prefersLeader ? 0 : 1, joinedAt, id];
  }
  /** Do we rank above peer `id` for leading (independentStop: playing first; then prefersLeader, oldest, lowest id)? */
  private outranks(id: string): boolean {
    const p = this.peers.get(id);
    return p ? before(this.myRank(), this.peerRank(p)) : this.id < id;
  }
  /** No peer known (so no leader known) and no Web Locks: lead at once. */
  private becomeLeaderIfAlone(): void { if (!this.peers.size && !this.locks && this.caps.canLead) this.setLeader(true); }
  private setLeader(on: boolean): void {
    if (on === this.leader) return;
    this.leader = on;
    this.idleEnd = false;
    // A handoff keeps the session swing: the new leader sends the swing it was following until its app publishes.
    this.carriedSwing = on && this.indep && this.clock.transport.running ? this.appliedSwing : null;
    if (on) { this.term += 1; this.broadcastState(); }
    emit(this.roleListeners, on ? 'leader' : 'follower');
    // A new leader whose own instrument plays on a stopped (or ending) session starts or keeps the run: a start
    // request sent to the old leader may have been dropped in the handoff.
    if (on && this.indep && this.clock.playing && !this.clock.transport.running) this.decideStart();
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
    if (changed) { this.emitPeers(); this.elect(); this.endSessionIfIdle(); }
    this.sendHeartbeat();
  }
  private sendHeartbeat(swing?: number): void {
    this.send({ type: 'heartbeat', app: this.o.app, leader: this.leader, audio: this.o.audio(), hidden: this.o.hidden(),
      outputLatencyMs: this.o.outputLatencyMs(), joinedAt: this.joinedAt, capabilities: this.caps, ...this.memberField(), swing });
  }
  private emitPeers(): void { this.syncHeartbeat(); emit(this.peerListeners, [...this.peers.values()]); }
  /** Run the heartbeat timer only while joined and at least one other peer is known. */
  private syncHeartbeat(): void {
    const want = !!this.channel && this.peers.size > 0;
    if (want && !this.heartbeat) this.heartbeat = setInterval(() => this.beat(), this.o.heartbeatMs);
    else if (!want && this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
  }
  /** True while the heartbeat timer runs (diagnostics and tests). */
  get beating(): boolean { return this.heartbeat !== null; }
  /**
   * Send one heartbeat when the page is shown again (visibilitychange to visible, or pageshow, e.g. back from
   * the back/forward cache). A lone peer has no heartbeat timer, so if it missed a newcomer's `hello` (frozen or
   * throttled in the background) and the newcomer is alone too (under Web Locks it waits for the lock and never
   * leads), neither would ever hear the other. One heartbeat on wake lets the newcomer find it, and the two then
   * beat as usual. Skipped where there is no `document` / `window` (Node, workers). Removed on {@link stop}.
   */
  private listenForWake(): void {
    type Target = { addEventListener?(type: string, l: () => void): void; removeEventListener?(type: string, l: () => void): void };
    const g = globalThis as { document?: Target & { visibilityState?: string }; window?: Target };
    const doc = typeof g.document?.addEventListener === 'function' ? g.document : null;
    const win = typeof g.window?.addEventListener === 'function' ? g.window : null;
    if (!doc && !win) return;
    const onWake = () => { if (doc?.visibilityState !== 'hidden') this.sendHeartbeat(); };
    doc?.addEventListener!('visibilitychange', onWake);
    win?.addEventListener!('pageshow', onWake);
    this.stopWakeListeners = () => {
      doc?.removeEventListener?.('visibilitychange', onWake);
      win?.removeEventListener?.('pageshow', onWake);
    };
  }
  private send<M extends NcSyncMessage>(body: MessageBody<M> | Record<string, unknown>): void {
    if (!this.channel) return;
    this.channel.postMessage(envelope(body as MessageBody<M>, this.id, this.term, ++this.seq, this.o.now()));
  }
}
