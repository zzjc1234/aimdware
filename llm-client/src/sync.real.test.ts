/**
 * Real Tbox integration test. Skipped automatically when no Tbox is
 * reachable. Override via env vars:
 *   AIMDWARE_TBOX_URL  (default http://127.0.0.1:50471)
 *   AIMDWARE_TBOX_USER (default admin)
 *   AIMDWARE_TBOX_PASS (default admin)
 */
import { test, expect } from "bun:test";
import { createClient } from "webdav";
import { makeWebDAVPut, syncBlob } from "./sync";

const TBOX_URL = process.env.AIMDWARE_TBOX_URL ?? "http://127.0.0.1:50471";
const TBOX_USER = process.env.AIMDWARE_TBOX_USER ?? "admin";
const TBOX_PASS = process.env.AIMDWARE_TBOX_PASS ?? "admin";

async function reachable(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    await fetch(TBOX_URL, { signal: ctrl.signal });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}

test("real Tbox: PUT (with auto-MKCOL) then GET roundtrip", async () => {
  if (!(await reachable())) {
    console.log(`[skip] Tbox not reachable at ${TBOX_URL}`);
    return;
  }
  const auth = { username: TBOX_USER, password: TBOX_PASS };
  const put = makeWebDAVPut(TBOX_URL, auth);

  const subdir = `aimdware-it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const path = `/${subdir}/sample.json`;
  const payload = new TextEncoder().encode(`{"hello":"tbox","ts":${Date.now()}}`);

  const result = await syncBlob(put, path, payload);
  expect(result).toEqual({ kind: "synced" });

  const client = createClient(TBOX_URL, auth);
  const got = (await client.getFileContents(path)) as Buffer;
  expect(Buffer.from(got).equals(Buffer.from(payload))).toBe(true);

  // Cleanup (best effort).
  try {
    await client.deleteFile(`/${subdir}`);
  } catch {
    /* ignore */
  }
});

test("real Tbox: second PUT to the same parent reuses cached MKCOL (no extra MKCOL roundtrip)", async () => {
  if (!(await reachable())) {
    console.log(`[skip] Tbox not reachable at ${TBOX_URL}`);
    return;
  }
  const auth = { username: TBOX_USER, password: TBOX_PASS };
  const put = makeWebDAVPut(TBOX_URL, auth);

  const subdir = `aimdware-it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pathA = `/${subdir}/a.json`;
  const pathB = `/${subdir}/b.json`;

  expect(await syncBlob(put, pathA, new TextEncoder().encode("A"))).toEqual({ kind: "synced" });
  expect(await syncBlob(put, pathB, new TextEncoder().encode("B"))).toEqual({ kind: "synced" });

  const client = createClient(TBOX_URL, auth);
  expect(Buffer.from((await client.getFileContents(pathA)) as Buffer).toString()).toBe("A");
  expect(Buffer.from((await client.getFileContents(pathB)) as Buffer).toString()).toBe("B");

  try {
    await client.deleteFile(`/${subdir}`);
  } catch {
    /* ignore */
  }
});

test("real Tbox: wrong password yields a fatal (4xx) sync result", async () => {
  if (!(await reachable())) {
    console.log(`[skip] Tbox not reachable at ${TBOX_URL}`);
    return;
  }
  const put = makeWebDAVPut(TBOX_URL, { username: "admin", password: "definitely-wrong" });
  const path = `/aimdware-it-${Date.now()}/x.json`;
  const r = await syncBlob(put, path, new TextEncoder().encode("x"));
  expect(r.kind).toBe("fatal");
});
