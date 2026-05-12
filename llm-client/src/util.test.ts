import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomic, redactToken } from "./util";

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "aimdware-atomic-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("writeAtomic writes the full content to the target path", async () => {
  const dir = freshDir();
  const target = join(dir, "file.json");
  await writeAtomic(target, new TextEncoder().encode("hello"));
  expect(readFileSync(target, "utf-8")).toBe("hello");
});

test("writeAtomic leaves no temp files in the directory on success", async () => {
  const dir = freshDir();
  await writeAtomic(join(dir, "a.json"), new TextEncoder().encode("x"));
  await writeAtomic(join(dir, "b.json"), new TextEncoder().encode("y"));
  const files = readdirSync(dir);
  expect(files.sort()).toEqual(["a.json", "b.json"]);
});

test("writeAtomic overwrites an existing file", async () => {
  const dir = freshDir();
  const target = join(dir, "file.json");
  await writeAtomic(target, new TextEncoder().encode("first"));
  await writeAtomic(target, new TextEncoder().encode("second"));
  expect(readFileSync(target, "utf-8")).toBe("second");
});

test("writeAtomic on a non-existent directory throws (does not silently mkdir)", async () => {
  await expect(
    writeAtomic("/nonexistent/dir/x.json", new TextEncoder().encode("x")),
  ).rejects.toThrow();
});

test("redactToken keeps only the 8-char prefix; full plaintext never appears", () => {
  const plaintext = "st_K9aBxYz1234567890abcdefghijklmnopqrstuvwxyz";
  const redacted = redactToken(plaintext);
  expect(redacted.startsWith("st_K9aBx")).toBe(true);
  expect(redacted).not.toContain(plaintext.slice(8));
  expect(redacted).not.toContain(plaintext);
});

test("redactToken collapses short / empty values without leaking", () => {
  expect(redactToken("")).toBe("(unset)");
  expect(redactToken(undefined)).toBe("(unset)");
  expect(redactToken(null)).toBe("(unset)");
  expect(redactToken("short")).toBe("***");
});
