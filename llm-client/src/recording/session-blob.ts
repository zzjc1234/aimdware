import { decodeBytes, tryParseJSON } from "./capture";

export type SessionBlobInput = {
  session_id: string;
  course: string;
  assignment: string;
  started_at: Date;
  latest_ts: Date;
  turn_count: number;
  upstream_type: string;
  upstream_status: number;
  request_bytes: Uint8Array;
  response_bytes: Uint8Array;
};

export type SessionBlobResult = {
  blob_bytes: Uint8Array;
  blob_hash: Uint8Array;
  blob_size: number;
};

/**
 * Build the per-session blob file. Each new turn overwrites this file
 * on jbox, so it always reflects the latest known state of the session.
 *
 * Schema (source of truth — anything the model saw is in `request`,
 * anything it returned is in `response`):
 *
 *   {
 *     session_id, course, started_at, latest_ts, turn_count,
 *     upstream: { type }, upstream_status,
 *     request:  <the parsed chat-completion body verbatim>,
 *     response: <the parsed response body, or the raw string if not JSON
 *               (streaming SSE comes through as a string here)>
 *   }
 *
 * Consumers read `request.messages`, `request.tools`, `request.model`,
 * `request.temperature`, etc. directly. We do NOT extract individual
 * fields onto the blob root — that just means we'd have to extend the
 * extractor every time the upstream protocol gains a parameter
 * (response_format, parallel_tool_calls, reasoning_effort, …). Source
 * of truth, single place.
 */
export function buildSessionBlob(input: SessionBlobInput): SessionBlobResult {
  const reqText = decodeBytes(input.request_bytes);
  const respText = decodeBytes(input.response_bytes);
  const parsedReq = tryParseJSON(reqText);
  const parsedResp = tryParseJSON(respText);

  const blob = {
    session_id: input.session_id,
    course: input.course,
    assignment: input.assignment,
    started_at: input.started_at.toISOString(),
    latest_ts: input.latest_ts.toISOString(),
    turn_count: input.turn_count,
    upstream: { type: input.upstream_type },
    upstream_status: input.upstream_status,
    request: parsedReq,
    response: parsedResp,
  };

  const blob_bytes = new TextEncoder().encode(JSON.stringify(blob, null, 2));
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(blob_bytes);
  const blob_hash = hasher.digest() as Uint8Array;
  return { blob_bytes, blob_hash, blob_size: blob_bytes.byteLength };
}
