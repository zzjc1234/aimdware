import { decodeBytes, tryParseJSON } from "./capture";

export type SessionBlobInput = {
  session_id: string;
  course: string;
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
 * on jbox, so it always reflects the latest known state of the session:
 *   - `messages` is the final turn's request.messages (already contains
 *     the full history because the agent re-sends everything every turn)
 *   - `latest_response` is the final turn's response
 *
 * TT reads this file and the conversation it sees is the conversation
 * as of the latest turn — no per-turn snapshots to stitch together.
 */
export function buildSessionBlob(input: SessionBlobInput): SessionBlobResult {
  const reqText = decodeBytes(input.request_bytes);
  const respText = decodeBytes(input.response_bytes);
  const parsedReq = tryParseJSON(reqText);
  const parsedResp = tryParseJSON(respText);

  let model: string | null = null;
  let messages: unknown[] = [];
  let tools: unknown = null;
  let tool_choice: unknown = null;
  if (parsedReq && typeof parsedReq === "object") {
    const req = parsedReq as {
      model?: unknown;
      messages?: unknown;
      tools?: unknown;
      tool_choice?: unknown;
    };
    model = typeof req.model === "string" ? req.model : null;
    messages = Array.isArray(req.messages) ? req.messages : [];
    // Preserve tool definitions + tool_choice so a TT can see what
    // capabilities the agent gave the model, not just which it used.
    tools = req.tools ?? null;
    tool_choice = req.tool_choice ?? null;
  }

  const blob = {
    session_id: input.session_id,
    course: input.course,
    started_at: input.started_at.toISOString(),
    latest_ts: input.latest_ts.toISOString(),
    turn_count: input.turn_count,
    upstream: { type: input.upstream_type },
    upstream_status: input.upstream_status,
    model,
    messages,
    tools,
    tool_choice,
    latest_response: parsedResp,
  };

  const blob_bytes = new TextEncoder().encode(JSON.stringify(blob, null, 2));
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(blob_bytes);
  const blob_hash = hasher.digest() as Uint8Array;
  return { blob_bytes, blob_hash, blob_size: blob_bytes.byteLength };
}
