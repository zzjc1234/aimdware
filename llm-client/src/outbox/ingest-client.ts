import { getProxyForUrl } from "../http/net";
import type { FetchLike } from "../http/proxy";

export type IngestBody = {
  record_id: string;
  session_id: string;
  turn_count: number;
  course_code: string;
  assignment: string;
  blob_hash: string;
  blob_uri: string;
  blob_size: number;
  model?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  ts: string;
  router_version: string;
  client_meta?: Record<string, unknown>;
};

export type PostContextResult =
  | { kind: "created"; record_id: string }
  | { kind: "exists"; record_id: string }
  | { kind: "conflict" }
  | { kind: "retryable"; status: number; reason: string }
  | { kind: "fatal"; status: number; reason: string };

export type PostContextOpts = {
  fetchImpl?: FetchLike;
};

export type ConfirmResult =
  | { kind: "ok" }
  | { kind: "retryable"; status: number; reason: string }
  | { kind: "fatal"; status: number; reason: string };

export async function confirmUploaded(
  backendUrl: string,
  studentToken: string,
  recordId: string,
  opts: PostContextOpts = {},
): Promise<ConfirmResult> {
  const target = new URL(
    `/ingest/context/${encodeURIComponent(recordId)}/uploaded`,
    backendUrl,
  );
  const f: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const proxy = getProxyForUrl(target);
  let res: Response;
  try {
    const init: RequestInit & { proxy?: string } = {
      method: "POST",
      headers: { authorization: `Bearer ${studentToken}` },
    };
    if (proxy !== undefined) init.proxy = proxy;
    res = await f(target, init);
  } catch (e) {
    return { kind: "retryable", status: 0, reason: (e as Error).message };
  }

  if (res.status === 200 || res.status === 202) return { kind: "ok" };
  if (res.status >= 500 || res.status === 429) {
    return {
      kind: "retryable",
      status: res.status,
      reason: `backend returned ${res.status}`,
    };
  }
  return {
    kind: "fatal",
    status: res.status,
    reason: `backend returned ${res.status}`,
  };
}

export async function postContext(
  backendUrl: string,
  studentToken: string,
  body: IngestBody,
  opts: PostContextOpts = {},
): Promise<PostContextResult> {
  const target = new URL("/ingest/context", backendUrl);
  const f: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const proxy = getProxyForUrl(target);

  let res: Response;
  try {
    const init: RequestInit & { proxy?: string } = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${studentToken}`,
      },
      body: JSON.stringify(body),
    };
    if (proxy !== undefined) init.proxy = proxy;
    res = await f(target, init);
  } catch (e) {
    return {
      kind: "retryable",
      status: 0,
      reason: (e as Error).message,
    };
  }

  if (res.status === 202) return { kind: "created", record_id: body.record_id };
  if (res.status === 200) return { kind: "exists", record_id: body.record_id };
  if (res.status === 409) return { kind: "conflict" };
  if (res.status >= 500 || res.status === 429) {
    return {
      kind: "retryable",
      status: res.status,
      reason: `backend returned ${res.status}`,
    };
  }
  // 4xx other (auth, schema, etc.)
  return {
    kind: "fatal",
    status: res.status,
    reason: `backend returned ${res.status}`,
  };
}
