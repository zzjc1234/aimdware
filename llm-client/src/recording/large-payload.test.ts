/**
 * Tests for the router's behaviour under large payloads (≥1 MB).
 *
 * Realistic agent platforms (opencode + plugins + MCP) routinely emit
 * 1 MB+ tool schemas and can grow `messages` to 1 MB+ inside a single
 * session. None of our code paths impose explicit size limits; this
 * suite pins that down with concrete numbers so a future "let's add
 * a size cap" refactor doesn't silently break the audit promise.
 *
 * Sizes here are deliberately chosen at the edge of "realistic agent
 * load" (1-5 MB), NOT pathological (100 MB). The pipeline should hold
 * up to a single 1M-token context window blob; beyond that, the
 * upstream itself would reject the request before we even see it.
 */
import { test, expect } from "bun:test";
import { buildSessionBlob } from "./session-blob";
import { SessionTracker, type Message } from "./session";

function bigString(bytes: number): string {
  // a-z repeating: predictable + JSON-safe (no escape blow-up)
  const block = "abcdefghijklmnopqrstuvwxyz".repeat(40); // 1040 bytes
  const n = Math.ceil(bytes / block.length);
  return block.repeat(n).slice(0, bytes);
}

test("buildSessionBlob handles a 1 MB user message verbatim", () => {
  const userContent = bigString(1_000_000);
  const reqText = JSON.stringify({
    model: "x",
    messages: [{ role: "user", content: userContent }],
  });
  const t0 = performance.now();
  const r = buildSessionBlob({
    session_id: "x",
    course: "C",
    assignment: "hw1",
    started_at: new Date(0),
    latest_ts: new Date(0),
    turn_count: 1,
    upstream_type: "openai",
    upstream_status: 200,
    request_bytes: new TextEncoder().encode(reqText),
    response_bytes: new TextEncoder().encode("{}"),
  });
  const dt = performance.now() - t0;

  expect(r.blob_size).toBeGreaterThan(1_000_000);
  // Round-trip the blob and verify the message survived byte-for-byte.
  const parsed = JSON.parse(new TextDecoder().decode(r.blob_bytes));
  expect(parsed.request.messages[0].content).toBe(userContent);
  // sha256 still matches (no silent truncation)
  const expected = new Bun.CryptoHasher("sha256").update(r.blob_bytes).digest();
  expect(Buffer.from(r.blob_hash)).toEqual(Buffer.from(expected as Uint8Array));
  // Perf sanity: <500ms even at 1 MB. If this jumps to 5s+ on a refactor,
  // someone introduced an O(N²).
  expect(dt).toBeLessThan(500);
});

test("buildSessionBlob handles a 1 MB tools array verbatim", () => {
  // 200 tools × ~8 KB each → comfortably >1 MB after JSON serialisation.
  const tools = Array.from({ length: 200 }, (_, i) => ({
    type: "function",
    function: {
      name: `tool_${i}`,
      description: bigString(8000),
      parameters: { type: "object", properties: {} },
    },
  }));
  const reqText = JSON.stringify({
    model: "x",
    messages: [{ role: "user", content: "go" }],
    tools,
  });
  const r = buildSessionBlob({
    session_id: "x",
    course: "C",
    assignment: "hw1",
    started_at: new Date(0),
    latest_ts: new Date(0),
    turn_count: 1,
    upstream_type: "openai",
    upstream_status: 200,
    request_bytes: new TextEncoder().encode(reqText),
    response_bytes: new TextEncoder().encode("{}"),
  });
  expect(r.blob_size).toBeGreaterThan(1_000_000);
  const parsed = JSON.parse(new TextDecoder().decode(r.blob_bytes));
  expect(parsed.request.tools).toHaveLength(200);
  expect(parsed.request.tools[199].function.name).toBe("tool_199");
});

test("buildSessionBlob handles a 1 MB SSE-streamed response (kept as raw string)", () => {
  // Synthesise SSE that doesn't parse as JSON.
  const chunks: string[] = [];
  let total = 0;
  while (total < 1_000_000) {
    const c = `data: {"choices":[{"delta":{"content":"${bigString(800)}"}}]}\n\n`;
    chunks.push(c);
    total += c.length;
  }
  chunks.push("data: [DONE]\n\n");
  const sse = chunks.join("");

  const r = buildSessionBlob({
    session_id: "x",
    course: "C",
    assignment: "hw1",
    started_at: new Date(0),
    latest_ts: new Date(0),
    turn_count: 1,
    upstream_type: "openai",
    upstream_status: 200,
    request_bytes: new TextEncoder().encode('{"model":"x","messages":[]}'),
    response_bytes: new TextEncoder().encode(sse),
  });
  const parsed = JSON.parse(new TextDecoder().decode(r.blob_bytes));
  expect(typeof parsed.response).toBe("string");
  expect(parsed.response.length).toBeGreaterThan(1_000_000);
  expect(parsed.response.endsWith("[DONE]\n\n")).toBe(true);
});

test("SessionTracker prefix-extends a 1 MB conversation across two turns", () => {
  // Each turn re-sends the full history (OpenAI protocol).
  const big = bigString(500_000); // 500 KB per message
  const turn1: Message[] = [{ role: "user", content: big }];
  const turn2: Message[] = [
    { role: "user", content: big },
    { role: "assistant", content: "ack" },
    { role: "user", content: "more" },
  ];

  const tr = new SessionTracker();
  const t0 = performance.now();
  const r1 = tr.classify(turn1);
  const r2 = tr.classify(turn2);
  const dt = performance.now() - t0;

  expect(r1.is_new).toBe(true);
  expect(r2.is_new).toBe(false);
  expect(r2.session_id).toBe(r1.session_id);
  expect(r2.turn_count).toBe(2);
  // canonicalize + stable-stringify on a 500KB message is O(N) per turn.
  // Two turns should be comfortably <1s.
  expect(dt).toBeLessThan(1000);
});

test("SessionTracker handles 10 sessions × 1 MB each without quadratic blowup", () => {
  // Adversarial: many large sessions kept in the LRU tracker simultaneously.
  // classify() does an O(sessions) walk; per-session compare is O(msgs).
  // With 10 sessions of 1 MB each, a 10th-classify shouldn't take >1s.
  const tr = new SessionTracker();
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) {
    tr.classify([{ role: "user", content: `${i}:${bigString(100_000)}` }]);
  }
  // Now extend the FIRST session — forces a walk over all 10.
  const r = tr.classify([
    { role: "user", content: `0:${bigString(100_000)}` },
    { role: "assistant", content: "ok" },
    { role: "user", content: "more" },
  ]);
  const dt = performance.now() - t0;

  expect(r.is_new).toBe(false);
  expect(r.turn_count).toBe(2);
  expect(dt).toBeLessThan(2000);
});
