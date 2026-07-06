import { test, expect, afterEach } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { authFilePath, createFileAuthStore } from "./auth-store";

const tmpDirs: string[] = [];
function freshAuthPath(): string {
  const d = mkdtempSync(join(tmpdir(), "aimdware-authstore-"));
  tmpDirs.push(d);
  // nested so we also exercise directory creation
  return join(d, "state", "auth.json");
}
afterEach(() => {
  for (const d of tmpDirs.splice(0))
    rmSync(d, { recursive: true, force: true });
});

test("del removes a stored provider entry", async () => {
  const store = createFileAuthStore(freshAuthPath());
  await store.set("codex", { type: "oauth", refresh: "r", expires: 0 });
  expect(await store.get("codex")).toBeDefined();

  await store.del("codex");

  expect(await store.get("codex")).toBeUndefined();
});

test("del leaves other providers intact", async () => {
  const store = createFileAuthStore(freshAuthPath());
  await store.set("codex", { type: "oauth", refresh: "rc", expires: 0 });
  await store.set("copilot", { type: "oauth", refresh: "rp", expires: 0 });

  await store.del("codex");

  expect(await store.get("codex")).toBeUndefined();
  expect(await store.get("copilot")).toBeDefined();
});

test("auth.json is written owner-only (0600) inside a 0700 directory", async () => {
  const path = freshAuthPath();
  const store = createFileAuthStore(path);
  await store.set("codex", { type: "oauth", refresh: "secret", expires: 0 });

  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
});

test("tightens an already-existing parent directory to 0700", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aimdware-authdir-"));
  tmpDirs.push(dir);
  chmodSync(dir, 0o755); // simulate a pre-existing, loosely-permissioned cache dir
  const store = createFileAuthStore(join(dir, "auth.json"));

  await store.set("codex", { type: "oauth", refresh: "secret", expires: 0 });

  expect(statSync(dir).mode & 0o777).toBe(0o700);
});

test("does not alter the shared cache directory that holds other state", async () => {
  // Mirror main.ts: cacheDir holds records/ + queue.db alongside the auth file.
  const cacheDir = mkdtempSync(join(tmpdir(), "aimdware-cache-"));
  tmpDirs.push(cacheDir);
  chmodSync(cacheDir, 0o755);
  mkdirSync(join(cacheDir, "records"));

  const store = createFileAuthStore(authFilePath(cacheDir));
  await store.set("codex", { type: "oauth", refresh: "secret", expires: 0 });

  // The shared cache dir must be left untouched; only the credential's own
  // directory is locked to 0700.
  expect(statSync(cacheDir).mode & 0o777).toBe(0o755);
  expect(statSync(dirname(authFilePath(cacheDir))).mode & 0o777).toBe(0o700);
});

test("withLock serializes concurrent critical sections and returns the result", async () => {
  const store = createFileAuthStore(freshAuthPath(), { lockPollMs: 5 });
  const order: string[] = [];
  const section = (tag: string) =>
    store.withLock!(async () => {
      order.push(`${tag}-start`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`${tag}-end`);
      return tag;
    });

  const results = await Promise.all([section("A"), section("B")]);

  expect(results.sort()).toEqual(["A", "B"]);
  // The two sections must not interleave: whoever starts first also ends
  // before the other starts.
  expect(order[1]).toBe(`${order[0]![0]}-end`);
});

test("withLock steals a stale lock left behind by a crashed process", async () => {
  const path = freshAuthPath();
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, "");
  const longAgo = new Date(Date.now() - 120_000);
  utimesSync(lockPath, longAgo, longAgo);
  const store = createFileAuthStore(path, {
    lockStaleMs: 30_000,
    lockPollMs: 5,
  });

  let ran = false;
  await store.withLock!(async () => {
    ran = true;
  });

  expect(ran).toBe(true);
});

test("concurrent set calls do not lose provider entries", async () => {
  const store = createFileAuthStore(freshAuthPath());

  await Promise.all([
    store.set("codex", { type: "oauth", refresh: "rc", expires: 0 }),
    store.set("copilot", { type: "oauth", refresh: "rp", expires: 0 }),
  ]);

  expect(await store.get("codex")).toBeDefined();
  expect(await store.get("copilot")).toBeDefined();
});
