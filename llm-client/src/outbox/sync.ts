import { createClient, type WebDAVClient } from "webdav";

/**
 * Just enough surface for our PUTs. Lets tests inject a fake without
 * spinning up a real WebDAV server.
 */
export type WebDAVPutLike = (path: string, data: Uint8Array) => Promise<void>;

export type SyncResult =
  | { kind: "synced" }
  | { kind: "retryable"; reason: string }
  | { kind: "fatal"; reason: string };

export async function syncBlob(
  put: WebDAVPutLike,
  remotePath: string,
  data: Uint8Array,
): Promise<SyncResult> {
  try {
    await put(remotePath, data);
    return { kind: "synced" };
  } catch (e) {
    const err = e as Error & { status?: number; response?: { status?: number } };
    const status = err.status ?? err.response?.status;
    if (status === undefined) {
      // Network / DNS / connection refused / abort.
      return { kind: "retryable", reason: err.message ?? "unknown" };
    }
    if (status >= 500 || status === 429 || status === 408) {
      return { kind: "retryable", reason: `webdav ${status}` };
    }
    // Other 4xx — auth, malformed path, conflict, locked, etc. — non-retryable.
    return { kind: "fatal", reason: `webdav ${status}: ${err.message ?? ""}` };
  }
}

export type WebDAVAuth = { username: string; password: string };

/**
 * Build a webdav-package-backed PUT function bound to a Tbox URL.
 *
 * Lazily MKCOLs parent directories the first time a blob targets them.
 * Tbox returns 409 on PUT into a missing parent, so without this every
 * sync would fail until something else created the course folder.
 */
export function makeWebDAVPut(tboxUrl: string, auth?: WebDAVAuth): WebDAVPutLike {
  const client: WebDAVClient = createClient(
    tboxUrl,
    auth ? { username: auth.username, password: auth.password } : undefined,
  );
  const ensuredDirs = new Set<string>();
  return async (path, data) => {
    const slash = path.lastIndexOf("/");
    const parent = slash > 0 ? path.slice(0, slash) : "";
    if (parent && !ensuredDirs.has(parent)) {
      await client.createDirectory(parent, { recursive: true });
      ensuredDirs.add(parent);
    }
    const buf = Buffer.from(data);
    const ok = await client.putFileContents(path, buf, { overwrite: true });
    if (!ok) throw new Error("webdav putFileContents returned false");
  };
}
