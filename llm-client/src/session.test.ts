import { test, expect } from "bun:test";
import { SessionTracker, type Message } from "./session";

function msg(role: string, content: string): Message {
  return { role, content };
}

test("first request starts a new session with turn_count=1", () => {
  const tr = new SessionTracker();
  const r = tr.classify([msg("user", "hi")]);
  expect(r.is_new).toBe(true);
  expect(r.turn_count).toBe(1);
  expect(r.session_id).toMatch(/^[0-9a-f-]{36}$/);
});

test("request that strictly extends prior messages continues the same session", () => {
  const tr = new SessionTracker();
  const a = tr.classify([msg("user", "hi")]);
  const b = tr.classify([
    msg("user", "hi"),
    msg("assistant", "hello"),
    msg("user", "more"),
  ]);
  expect(b.session_id).toBe(a.session_id);
  expect(b.is_new).toBe(false);
  expect(b.turn_count).toBe(2);
});

test("a third extending turn keeps the session and increments turn_count", () => {
  const tr = new SessionTracker();
  tr.classify([msg("user", "a")]);
  tr.classify([msg("user", "a"), msg("assistant", "1"), msg("user", "b")]);
  const third = tr.classify([
    msg("user", "a"),
    msg("assistant", "1"),
    msg("user", "b"),
    msg("assistant", "2"),
    msg("user", "c"),
  ]);
  expect(third.is_new).toBe(false);
  expect(third.turn_count).toBe(3);
});

test("a different first message starts a new session", () => {
  const tr = new SessionTracker();
  const a = tr.classify([msg("user", "hi")]);
  const b = tr.classify([msg("user", "different")]);
  expect(b.session_id).not.toBe(a.session_id);
  expect(b.is_new).toBe(true);
});

test("a shorter messages array doesn't match a prior longer session — starts new", () => {
  const tr = new SessionTracker();
  const long = tr.classify([
    msg("user", "hi"),
    msg("assistant", "hello"),
    msg("user", "more"),
  ]);
  const shorter = tr.classify([msg("user", "hi")]);
  expect(shorter.session_id).not.toBe(long.session_id);
  expect(shorter.is_new).toBe(true);
});

test("two coexisting sessions (different prefixes) both continue correctly", () => {
  const tr = new SessionTracker();
  const a1 = tr.classify([msg("user", "AAA")]);
  const b1 = tr.classify([msg("user", "BBB")]);
  expect(a1.session_id).not.toBe(b1.session_id);

  const a2 = tr.classify([
    msg("user", "AAA"),
    msg("assistant", "x"),
    msg("user", "more A"),
  ]);
  const b2 = tr.classify([
    msg("user", "BBB"),
    msg("assistant", "y"),
    msg("user", "more B"),
  ]);
  expect(a2.session_id).toBe(a1.session_id);
  expect(b2.session_id).toBe(b1.session_id);
  expect(a2.turn_count).toBe(2);
  expect(b2.turn_count).toBe(2);
});

test("LRU evicts the least-recently-touched session when capacity is exceeded", () => {
  const tr = new SessionTracker(2);
  tr.classify([msg("user", "session-A")]);
  tr.classify([msg("user", "session-B")]);
  tr.classify([msg("user", "session-C")]); // evicts A
  const backToA = tr.classify([
    msg("user", "session-A"),
    msg("assistant", "x"),
    msg("user", "y"),
  ]);
  // A was evicted, so this looks like a brand-new session.
  expect(backToA.is_new).toBe(true);
});

test("identical messages array (no growth) is treated as a new session, not a continuation", () => {
  const tr = new SessionTracker();
  const a = tr.classify([msg("user", "hi")]);
  const b = tr.classify([msg("user", "hi")]);
  // Same content but no extension — could be a retry or a fresh ask. Treat as new.
  expect(b.session_id).not.toBe(a.session_id);
});

test("empty messages array produces a new session each time", () => {
  const tr = new SessionTracker();
  const a = tr.classify([]);
  const b = tr.classify([]);
  expect(a.is_new).toBe(true);
  expect(b.is_new).toBe(true);
  expect(a.session_id).not.toBe(b.session_id);
});

test("key order does not matter — reordered keys on the same message extend the session", () => {
  // Agents sometimes round-trip messages through their own serializer
  // and re-emit them with a different key order. If we did naive
  // JSON.stringify equality, the second turn would look like a new
  // session and we'd silently lose O(N) blob storage.
  const tr = new SessionTracker();
  const first = tr.classify([
    { role: "assistant", content: "x", name: "bot" } as Message,
  ]);
  const second = tr.classify([
    { name: "bot", content: "x", role: "assistant" } as Message, // same fields, reordered
    { role: "user", content: "continue" } as Message,
  ]);
  expect(second.is_new).toBe(false);
  expect(second.session_id).toBe(first.session_id);
  expect(second.turn_count).toBe(2);
});

test("deeply nested key reorder (tool_calls etc.) still matches", () => {
  const tr = new SessionTracker();
  const first = tr.classify([
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "1", type: "function", function: { name: "ls", arguments: "{}" } },
      ],
    } as Message,
  ]);
  const second = tr.classify([
    {
      tool_calls: [
        { function: { arguments: "{}", name: "ls" }, type: "function", id: "1" },
      ],
      content: null,
      role: "assistant",
    } as Message,
    { role: "tool", content: "a.txt", tool_call_id: "1" } as Message,
  ]);
  expect(second.is_new).toBe(false);
  expect(second.session_id).toBe(first.session_id);
});

test("messages with structured content (tool_calls etc.) compare correctly", () => {
  const tr = new SessionTracker();
  const a = tr.classify([
    { role: "user", content: "list files" } as Message,
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "1", function: { name: "ls", arguments: "{}" } }],
    } as Message,
  ]);
  const b = tr.classify([
    { role: "user", content: "list files" } as Message,
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "1", function: { name: "ls", arguments: "{}" } }],
    } as Message,
    { role: "tool", content: "a.txt b.txt", tool_call_id: "1" } as Message,
  ]);
  expect(b.session_id).toBe(a.session_id);
  expect(b.is_new).toBe(false);
});
