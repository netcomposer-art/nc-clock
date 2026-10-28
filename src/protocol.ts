/**
 * NC Sync v1 wire protocol: message types, envelope, and a validator.
 *
 * Vendor-neutral JSON over any ordered channel (BroadcastChannel, postMessage,
 * WebSocket relay). Pure (no DOM), so other runtimes and languages can follow
 * the same shapes; see docs/nc-sync-v1.md for the normative text.
 *
 * Compatibility rules: `proto` is `"nc-sync/<major>"`. A receiver drops
 * messages with another major, ignores unknown `type`s and unknown fields, and
 * never re-broadcasts a message it applied.
 *
 * @module
 */
import type { ClockSnapshot } from './core/snapshot.js';

/** Protocol id and major version carried in every message. */
export const PROTOCOL = 'nc-sync/1';
/** Protocol major version. */
export const PROTOCOL_MAJOR = 1;
/** Default BroadcastChannel name. */
export const DEFAULT_CHANNEL = 'nc-sync';
/** Default Web Lock name for leader election. */
export const LEADER_LOCK = 'nc-sync-leader';

/** Audio readiness of a peer. `needs-gesture`: the user must click that tab before it can sound. */
export type AudioReadiness = 'running' | 'suspended' | 'interrupted' | 'needs-gesture' | 'none';

/** What a peer can do. Unknown capabilities are ignored. */
export interface Capabilities {
  /** Inclusive tempo range `[min, max]` the peer can play. */
  tempoRange: [number, number];
  /** Follows tempo ramps (else it hears them as steps). */
  tempoRamps: boolean;
  /** Plays swing. */
  swing: boolean;
  /** Has its own meter (else it uses the leader's). */
  meter: boolean;
  /** Wants to be the leader (e.g. its sequencer runs on the audio thread). */
  prefersLeader: boolean;
  /** Can act as leader at all. */
  canLead: boolean;
  /** Schedules sample-accurately (audio thread) rather than from a main-thread lookahead. */
  sampleAccurate: boolean;
  /** Optional free-form modes the peer syncs in (e.g. `["generator", "arp"]`). */
  modes?: string[];
  /**
   * Stop is per instrument (nc-clock 0.5.0, `NcSyncPeer({ independentStop: true })`): the peer sends its own
   * `playing` in `hello` and `heartbeat`, its Stop stops only itself, and the session (the shared transport) ends
   * when the last instrument stops. Absent means false: every Stop is a session stop.
   */
  independentStop?: boolean;
}

/** Fields on every message. */
export interface Envelope {
  /** {@link PROTOCOL}. */
  proto: string;
  /** Message type. */
  type: string;
  /** Sender instance id (unique per tab/process). */
  from: string;
  /** Leader term the sender knows. State from an older term is ignored. */
  term: number;
  /** Sender's message counter, strictly increasing. (`from`, `seq`) is unique; receivers drop repeats. */
  seq: number;
  /** Sender's shared time when sent (seconds since the Unix epoch). */
  sentAt: number;
}

/** Join announcement. The leader answers with `state`. */
export interface HelloMessage extends Envelope { type: 'hello'; app: string; version: string; capabilities: Capabilities; audio: AudioReadiness; outputLatencyMs: number | null; joinedAt: number;
  /** `independentStop` peers only: this instrument is playing (its own state, not the transport's). */
  playing?: boolean }
/** Leaving (best effort; liveness also comes from heartbeats and the leader lock). */
export interface ByeMessage extends Envelope { type: 'bye' }
/** About once a second. `hidden` peers may beat as rarely as once a minute (browser throttling). */
export interface HeartbeatMessage extends Envelope { type: 'heartbeat'; app: string; leader: boolean; audio: AudioReadiness; hidden: boolean; outputLatencyMs: number | null; joinedAt: number; capabilities: Capabilities;
  /** `independentStop` peers only: this instrument is playing. Sent at once when it changes, not only every second. */
  playing?: boolean;
  /** A session swing edit from a peer that led the running session and no longer leads (`publishState()`): the
   *  leader applies it, and every peer keeps it until a `state` carries it, so a new leader applies it if the lead
   *  moved first. Ignored from a peer that did not lead the running session. */
  swing?: number }
/** Leader only: the full clock. Followers apply it as is. */
export interface StateMessage extends Envelope {
  type: 'state'; clock: ClockSnapshot;
  /** Where the second 16th of each 8th-note pair lands, as a fraction of the pair: 0.5 straight to 0.75 dotted.
   * The leader's own, or the session swing it keeps; 0 when it has none. See {@link readSwing}. */
  swing: number;
  leaderApp: string; stopAll?: boolean;
  /** Set by an `independentStop` leader: a plain transport stop here is a session end after the last instrument
   * stopped, so receivers keep their own play state. */
  independentStop?: boolean;
  /** With a stop: every instrument stops (a `stop` request, or `all`). Only `independentStop` leaders send it. */
  endSession?: boolean;
}
/** Request (to the leader) to start or stop. */
export interface TransportMessage extends Envelope { type: 'transport'; action: 'start' | 'stop'; atBeat?: number; all?: boolean }
/** Request (to the leader) to change tempo. */
export interface TempoMessage extends Envelope { type: 'tempo'; bpm: number; atBeat?: number; rampBeats?: number }
/** Snapshot slot action, for any peer. `recall` is idempotent; `store` is opt-in per app. */
export interface SnapshotMessage extends Envelope { type: 'snapshot'; op: 'recall' | 'stopSequence' | 'store'; slot: number; atBeat?: number; glide?: { beats?: number; seconds?: number } }
/** Relay mode only: round-trip probe. */
export interface PingMessage extends Envelope { type: 'ping'; id: string }
/** Relay mode only: answer to `ping`. */
export interface PongMessage extends Envelope { type: 'pong'; id: string; receivedAt: number }
/** Reserved for a later minor version (note events). Receivers may ignore it. */
export interface NotesMessage extends Envelope { type: 'notes'; notes: { beat: number; note: number; velocity: number; lengthBeats: number }[] }

/** Any NC Sync v1 message. */
export type NcSyncMessage = HelloMessage | ByeMessage | HeartbeatMessage | StateMessage | TransportMessage | TempoMessage
  | SnapshotMessage | PingMessage | PongMessage | NotesMessage;

/** The message `type`s defined by v1. */
export const MESSAGE_TYPES = ['hello', 'bye', 'heartbeat', 'state', 'transport', 'tempo', 'snapshot', 'ping', 'pong', 'notes'] as const;

/** Body of a message: everything except the envelope. */
export type MessageBody<M extends NcSyncMessage> = Omit<M, keyof Envelope> & { type: M['type'] };

/** `state.swing` value meaning "this leader has no session swing" (its app sets none and it keeps none). */
export const SWING_UNSET = 0;
/** `state.swing` for straight 16ths. */
export const SWING_STRAIGHT = 0.5;
/** Widest `state.swing` in NC Sync v1 (dotted 16ths, 3:1). */
export const SWING_MAX = 0.75;

/** A usable `state.swing` (0.5 to 0.75), or null when it is unset, out of range or not a number. */
export function readSwing(value: unknown): number | null {
  return typeof value === 'number' && value >= SWING_STRAIGHT && value <= SWING_MAX ? value : null;
}

/** Default capabilities: a main-thread follower with no ramps, swing or meter. */
export const DEFAULT_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  tempoRange: [20, 300] as [number, number], tempoRamps: false, swing: false, meter: false,
  prefersLeader: false, canLead: true, sampleAccurate: false,
});

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown) => typeof v === 'string' && v.length > 0;

/**
 * Validate an incoming value. Returns the typed message, or null when it is not NC Sync v1,
 * is malformed, or has an unknown type (unknown types are ignored, not errors).
 */
export function parseMessage(value: unknown): NcSyncMessage | null {
  const m = value as Record<string, unknown>;
  if (!m || typeof m !== 'object') return null;
  if (typeof m.proto !== 'string' || !m.proto.startsWith('nc-sync/')) return null;
  if (parseInt(m.proto.slice(8), 10) !== PROTOCOL_MAJOR) return null;
  if (!str(m.type) || !str(m.from) || !num(m.term) || !num(m.seq) || !num(m.sentAt)) return null;
  switch (m.type) {
    case 'hello': return str(m.app) && typeof m.capabilities === 'object' && m.capabilities ? m as unknown as HelloMessage : null;
    case 'bye': return m as unknown as ByeMessage;
    case 'heartbeat': return m as unknown as HeartbeatMessage;
    case 'state': return m.clock && typeof m.clock === 'object' ? m as unknown as StateMessage : null;
    case 'transport': return m.action === 'start' || m.action === 'stop' ? m as unknown as TransportMessage : null;
    case 'tempo': return num(m.bpm) && (m.bpm as number) > 0 ? m as unknown as TempoMessage : null;
    case 'snapshot': return (m.op === 'recall' || m.op === 'stopSequence' || m.op === 'store') && num(m.slot) ? m as unknown as SnapshotMessage : null;
    case 'ping': case 'pong': return str(m.id) ? m as unknown as PingMessage | PongMessage : null;
    case 'notes': return Array.isArray(m.notes) ? m as unknown as NotesMessage : null;
    default: return null;
  }
}

/** Wrap a body in an envelope. */
export function envelope<M extends NcSyncMessage>(body: MessageBody<M>, from: string, term: number, seq: number, sentAt: number): M {
  return { proto: PROTOCOL, from, term, seq, sentAt, ...body } as unknown as M;
}
