import { test, expect, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFileAuthStore } from "./auth-store";

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

test("concurrent set calls do not lose provider entries", async () => {
  const store = createFileAuthStore(freshAuthPath());

  await Promise.all([
    store.set("codex", { type: "oauth", refresh: "rc", expires: 0 }),
    store.set("copilot", { type: "oauth", refresh: "rp", expires: 0 }),
  ]);

  expect(await store.get("codex")).toBeDefined();
  expect(await store.get("copilot")).toBeDefined();
});
