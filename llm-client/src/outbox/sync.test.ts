import { test, expect } from "bun:test";
import { syncBlob, type WebDAVPutLike, type SyncResult } from "./sync";

const ok: WebDAVPutLike = async () => {};

test("syncBlob success -> synced", async () => {
  let putPath = "";
  let putBytes: Uint8Array = new Uint8Array();
  const put: WebDAVPutLike = async (path, data) => {
    putPath = path;
    putBytes = data;
  };

  const result = await syncBlob(
    put,
    "/aimdware/ECE4721J/abc.json",
    new TextEncoder().encode("payload"),
  );

  expect(result).toEqual<SyncResult>({ kind: "synced" });
  expect(putPath).toBe("/aimdware/ECE4721J/abc.json");
  expect(new TextDecoder().decode(putBytes)).toBe("payload");
});

test("syncBlob network error -> retryable", async () => {
  const put: WebDAVPutLike = async () => {
    throw new TypeError("Connection refused");
  };
  const result = await syncBlob(put, "/x", new Uint8Array());
  expect(result.kind).toBe("retryable");
});

test("syncBlob WebDAV 5xx -> retryable", async () => {
  const put: WebDAVPutLike = async () => {
    const e: Error & { status?: number } = new Error("server error");
    e.status = 503;
    throw e;
  };
  const result = await syncBlob(put, "/x", new Uint8Array());
  expect(result.kind).toBe("retryable");
  if (result.kind === "retryable") expect(result.reason).toContain("503");
});

test("syncBlob WebDAV 401 -> fatal", async () => {
  const put: WebDAVPutLike = async () => {
    const e: Error & { status?: number } = new Error("unauthorized");
    e.status = 401;
    throw e;
  };
  const result = await syncBlob(put, "/x", new Uint8Array());
  expect(result.kind).toBe("fatal");
});

test("syncBlob WebDAV 409 -> fatal (likely a path/server config bug)", async () => {
  const put: WebDAVPutLike = async () => {
    const e: Error & { status?: number } = new Error("conflict");
    e.status = 409;
    throw e;
  };
  const result = await syncBlob(put, "/x", new Uint8Array());
  expect(result.kind).toBe("fatal");
});

test("syncBlob 429 rate-limited -> retryable", async () => {
  const put: WebDAVPutLike = async () => {
    const e: Error & { status?: number } = new Error("too many requests");
    e.status = 429;
    throw e;
  };
  const result = await syncBlob(put, "/x", new Uint8Array());
  expect(result.kind).toBe("retryable");
});

test("syncBlob with explicit ok handler reports a synced result", async () => {
  const r = await syncBlob(ok, "/p", new Uint8Array());
  expect(r.kind).toBe("synced");
});
