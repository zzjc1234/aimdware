import { test, expect } from "bun:test";
import { buildSessionBlob } from "./session-blob";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function dec(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

const reqText =
  '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"hello"},{"role":"user","content":"more"}]}';
const respText =
  '{"id":"chatcmpl-x","choices":[{"message":{"role":"assistant","content":"sure"}}]}';

test("router metadata is at blob root; the whole parsed request lives under `request`", () => {
  const r = buildSessionBlob({
    session_id: "11111111-2222-3333-4444-555555555555",
    course: "ECE4721J",
    assignment: "hw1",
    started_at: new Date("2026-05-13T10:00:00Z"),
    latest_ts: new Date("2026-05-13T10:01:00Z"),
    turn_count: 2,
    upstream_type: "openai",
    upstream_status: 200,
    request_bytes: enc(reqText),
    response_bytes: enc(respText),
  });

  const obj = JSON.parse(dec(r.blob_bytes));
  // Router-side metadata (NOT in the request body).
  expect(obj.session_id).toBe("11111111-2222-3333-4444-555555555555");
  expect(obj.course).toBe("ECE4721J");
  expect(obj.turn_count).toBe(2);
  expect(obj.upstream_status).toBe(200);
  expect(obj.upstream).toEqual({ type: "openai" });

  // The parsed request is the source of truth for what the model saw.
  expect(obj.request.model).toBe("gpt-4o");
  expect(obj.request.messages).toHaveLength(3);
  expect(obj.request.messages[2]).toEqual({ role: "user", content: "more" });

  // The response, parsed if JSON, raw string if not.
  expect(obj.response.choices[0].message.content).toBe("sure");
});

test("ANY field on the request body is preserved verbatim (future-proof)", () => {
  // Throw a kitchen sink at the router and verify nothing got dropped.
  // Includes fields that don't exist today but might tomorrow.
  const futureRequestText = JSON.stringify({
    model: "x",
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.7,
    top_p: 0.9,
    max_tokens: 1024,
    presence_penalty: 0.1,
    frequency_penalty: 0.2,
    seed: 42,
    stop: ["END"],
    response_format: { type: "json_object" },
    parallel_tool_calls: true,
    reasoning_effort: "high",
    // and a hypothetical future field
    fancy_new_param_2027: { foo: "bar" },
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
    request_bytes: enc(futureRequestText),
    response_bytes: enc("{}"),
  });
  const obj = JSON.parse(dec(r.blob_bytes));
  expect(obj.request.temperature).toBe(0.7);
  expect(obj.request.top_p).toBe(0.9);
  expect(obj.request.max_tokens).toBe(1024);
  expect(obj.request.presence_penalty).toBe(0.1);
  expect(obj.request.frequency_penalty).toBe(0.2);
  expect(obj.request.seed).toBe(42);
  expect(obj.request.stop).toEqual(["END"]);
  expect(obj.request.response_format).toEqual({ type: "json_object" });
  expect(obj.request.parallel_tool_calls).toBe(true);
  expect(obj.request.reasoning_effort).toBe("high");
  expect(obj.request.fancy_new_param_2027).toEqual({ foo: "bar" });
});

test("tools + tool_choice round-trip through `request`", () => {
  const toolRequestText = JSON.stringify({
    model: "x",
    messages: [{ role: "user", content: "list files" }],
    tools: [
      {
        type: "function",
        function: {
          name: "fs_read",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      },
    ],
    tool_choice: "auto",
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
    request_bytes: enc(toolRequestText),
    response_bytes: enc("{}"),
  });
  const obj = JSON.parse(dec(r.blob_bytes));
  expect(obj.request.tools).toHaveLength(1);
  expect(obj.request.tools[0].function.name).toBe("fs_read");
  expect(obj.request.tool_choice).toBe("auto");
});

test("blob is pretty-printed and the hash matches sha256(blob_bytes)", () => {
  const r = buildSessionBlob({
    session_id: "abc",
    course: "X",
    assignment: "hw1",
    started_at: new Date(0),
    latest_ts: new Date(0),
    turn_count: 1,
    upstream_type: "openai",
    upstream_status: 200,
    request_bytes: enc(reqText),
    response_bytes: enc(respText),
  });
  expect(dec(r.blob_bytes)).toContain('\n  "session_id":');
  const expected = new Bun.CryptoHasher("sha256").update(r.blob_bytes).digest();
  expect(Buffer.from(r.blob_hash)).toEqual(Buffer.from(expected as Uint8Array));
  expect(r.blob_size).toBe(r.blob_bytes.byteLength);
});

test("streaming SSE response stays as a raw string under `response`", () => {
  const sse =
    'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
    "data: [DONE]\n\n";
  const r = buildSessionBlob({
    session_id: "x",
    course: "Y",
    assignment: "hw1",
    started_at: new Date(0),
    latest_ts: new Date(0),
    turn_count: 1,
    upstream_type: "openai",
    upstream_status: 200,
    request_bytes: enc('{"model":"gpt-4o","stream":true,"messages":[]}'),
    response_bytes: enc(sse),
  });
  const obj = JSON.parse(dec(r.blob_bytes));
  expect(typeof obj.response).toBe("string");
  expect(obj.response).toBe(sse);
});

test("unparseable request bytes are kept verbatim under `request` (as a string)", () => {
  const r = buildSessionBlob({
    session_id: "x",
    course: "Y",
    assignment: "hw1",
    started_at: new Date(0),
    latest_ts: new Date(0),
    turn_count: 1,
    upstream_type: "openai",
    upstream_status: 200,
    request_bytes: enc("not json"),
    response_bytes: enc(""),
  });
  const obj = JSON.parse(dec(r.blob_bytes));
  // tryParseJSON returns the raw string for invalid JSON, so audit
  // can still see what the client sent.
  expect(obj.request).toBe("not json");
  expect(obj.response).toBe("");
});

test("two consecutive turns of the same session produce strictly growing blob sizes", () => {
  const turn1 = buildSessionBlob({
    session_id: "s1",
    course: "X",
    assignment: "hw1",
    started_at: new Date(0),
    latest_ts: new Date(0),
    turn_count: 1,
    upstream_type: "openai",
    upstream_status: 200,
    request_bytes: enc(
      '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}',
    ),
    response_bytes: enc('{"choices":[{"message":{"content":"hello"}}]}'),
  });
  const turn2 = buildSessionBlob({
    session_id: "s1",
    course: "X",
    assignment: "hw1",
    started_at: new Date(0),
    latest_ts: new Date(1),
    turn_count: 2,
    upstream_type: "openai",
    upstream_status: 200,
    request_bytes: enc(
      '{"model":"gpt-4o","messages":[' +
        '{"role":"user","content":"hi"},' +
        '{"role":"assistant","content":"hello"},' +
        '{"role":"user","content":"more"}]}',
    ),
    response_bytes: enc('{"choices":[{"message":{"content":"sure"}}]}'),
  });
  expect(turn2.blob_size).toBeGreaterThan(turn1.blob_size);
});
