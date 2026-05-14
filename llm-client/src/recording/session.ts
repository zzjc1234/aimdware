/**
 * Recognises whether a chat request continues a prior agent session by
 * checking whether its `messages` array is a strict extension of the
 * tip we last saw. Lets us store one blob per session (overwriting on
 * each turn) instead of one blob per HTTP call — turns O(N²) total
 * bytes into O(N).
 *
 * Identity is in-memory only: a router restart starts fresh sessions.
 * That's acceptable because we never need to *resume* — we just need to
 * keep the per-session blob keyed by a stable id within one run.
 */
import { randomUUID } from "node:crypto";

export type Message = {
  role: string;
  content: unknown;
  [extra: string]: unknown;
};

export type SessionClassification = {
  session_id: string;
  turn_count: number;
  is_new: boolean;
  started_at: Date;
};

type SessionState = {
  id: string;
  /** Last `messages` array we saw on a request that classified to this session. */
  tip: Message[];
  turn_count: number;
  started_at: Date;
  /** Monotonic counter used for LRU eviction (not wall clock — wall clock can tie). */
  last_seen_seq: number;
};

export class SessionTracker {
  private sessions: Map<string, SessionState> = new Map();
  private readonly capacity: number;
  private seq = 0;

  constructor(capacity = 32) {
    this.capacity = capacity;
  }

  /**
   * Classify a chat request's `messages` array as either continuing an
   * active session or starting a new one.
   */
  classify(messages: Message[], now: Date = new Date()): SessionClassification {
    // Search most-recently-touched sessions first.
    const ordered = [...this.sessions.values()].sort(
      (a, b) => b.last_seen_seq - a.last_seen_seq,
    );
    for (const s of ordered) {
      if (isPrefixOf(s.tip, messages)) {
        s.tip = messages;
        s.turn_count += 1;
        s.last_seen_seq = ++this.seq;
        return {
          session_id: s.id,
          turn_count: s.turn_count,
          is_new: false,
          started_at: s.started_at,
        };
      }
    }

    if (this.sessions.size >= this.capacity) this.evictOldest();
    const id = randomUUID();
    const state: SessionState = {
      id,
      tip: messages,
      turn_count: 1,
      started_at: now,
      last_seen_seq: ++this.seq,
    };
    this.sessions.set(id, state);
    return { session_id: id, turn_count: 1, is_new: true, started_at: now };
  }

  private evictOldest(): void {
    let oldest: SessionState | undefined;
    for (const s of this.sessions.values()) {
      if (!oldest || s.last_seen_seq < oldest.last_seen_seq) oldest = s;
    }
    if (oldest) this.sessions.delete(oldest.id);
  }
}

/**
 * True iff `prior` is a strict prefix of `next` (same length is NOT a prefix —
 * a turn without new content shouldn't be confused with a continuation).
 */
function isPrefixOf(prior: Message[], next: Message[]): boolean {
  if (prior.length === 0 || prior.length >= next.length) return false;
  for (let i = 0; i < prior.length; i++) {
    if (!messagesEqual(prior[i]!, next[i]!)) return false;
  }
  return true;
}

function messagesEqual(a: Message, b: Message): boolean {
  // Stable key ordering matters. Some agent clients round-trip messages
  // through their own serializers and re-emit with a different key order;
  // a naive JSON.stringify would treat that as a new session and silently
  // regress us to O(N²) blob storage.
  return canonicalStringify(a) === canonicalStringify(b);
}

function canonicalStringify(v: unknown): string {
  return JSON.stringify(canonicalize(v));
}

function canonicalize(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(canonicalize);
  const src = v as Record<string, unknown>;
  // Object.create(null) — not {} — so a "__proto__" key writes a regular
  // property instead of mutating the prototype chain.
  const out = Object.create(null) as Record<string, unknown>;
  for (const k of Object.keys(src).sort()) out[k] = canonicalize(src[k]);
  return out;
}
