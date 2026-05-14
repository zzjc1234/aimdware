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

test("builds a session-keyed pretty-printed JSON blob with the final turn's messages + response", () => {
  const r = buildSessionBlob({
    session_id: "11111111-2222-3333-4444-555555555555",
    course: "ECE4721J",
    started_at: new Date("2026-05-13T10:00:00Z"),
    latest_ts: new Date("2026-05-13T10:01:00Z"),
    turn_count: 2,
    upstream_type: "openai",
    upstream_status: 200,
    request_bytes: enc(reqText),
    response_bytes: enc(respText),
  });

  const obj = JSON.parse(dec(r.blob_bytes));
  expect(obj.session_id).toBe("11111111-2222-3333-4444-555555555555");
  expect(obj.course).toBe("ECE4721J");
  expect(obj.turn_count).toBe(2);
  expect(obj.upstream_status).toBe(200);
  expect(obj.upstream).toEqual({ type: "openai" });
  expect(obj.model).toBe("gpt-4o");
  expect(obj.messages).toHaveLength(3);
  expect(obj.messages[2]).toEqual({ role: "user", content: "more" });
  expect(obj.latest_response.choices[0].message.content).toBe("sure");
});

test("blob is pretty-printed and the hash matches sha256(blob_bytes)", () => {
  const r = buildSessionBlob({
    session_id: "abc",
    course: "X",
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

test("streaming SSE response stays as a raw string in `latest_response`", () => {
  const sse =
    'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
    "data: [DONE]\n\n";
  const r = buildSessionBlob({
    session_id: "x",
    course: "Y",
    started_at: new Date(0),
    latest_ts: new Date(0),
    turn_count: 1,
    upstream_type: "openai",
    upstream_status: 200,
    request_bytes: enc('{"model":"gpt-4o","stream":true,"messages":[]}'),
    response_bytes: enc(sse),
  });
  const obj = JSON.parse(dec(r.blob_bytes));
  expect(typeof obj.latest_response).toBe("string");
  expect(obj.latest_response).toBe(sse);
});

test("unparseable request bytes still produce a blob (messages=[], model=null)", () => {
  const r = buildSessionBlob({
    session_id: "x",
    course: "Y",
    started_at: new Date(0),
    latest_ts: new Date(0),
    turn_count: 1,
    upstream_type: "openai",
    upstream_status: 200,
    request_bytes: enc("not json"),
    response_bytes: enc(""),
  });
  const obj = JSON.parse(dec(r.blob_bytes));
  expect(obj.messages).toEqual([]);
  expect(obj.model).toBeNull();
});

test("two consecutive turns of the same session produce strictly growing blob sizes", () => {
  const turn1 = buildSessionBlob({
    session_id: "s1",
    course: "X",
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

test("tools + tool_choice in the request body are preserved on the blob", () => {
  const reqText = JSON.stringify({
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
    started_at: new Date(0),
    latest_ts: new Date(0),
    turn_count: 1,
    upstream_type: "openai",
    upstream_status: 200,
    request_bytes: new TextEncoder().encode(reqText),
    response_bytes: new TextEncoder().encode("{}"),
  });
  const obj = JSON.parse(new TextDecoder().decode(r.blob_bytes));
  expect(obj.tools).toHaveLength(1);
  expect(obj.tools[0].function.name).toBe("fs_read");
  expect(obj.tool_choice).toBe("auto");
});

test("missing tools / tool_choice → null on the blob (no surprises)", () => {
  const r = buildSessionBlob({
    session_id: "x",
    course: "C",
    started_at: new Date(0),
    latest_ts: new Date(0),
    turn_count: 1,
    upstream_type: "openai",
    upstream_status: 200,
    request_bytes: new TextEncoder().encode('{"model":"x","messages":[]}'),
    response_bytes: new TextEncoder().encode("{}"),
  });
  const obj = JSON.parse(new TextDecoder().decode(r.blob_bytes));
  expect(obj.tools).toBeNull();
  expect(obj.tool_choice).toBeNull();
});
