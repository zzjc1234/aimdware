import { rename } from "node:fs/promises";

/**
 * Write data to `path` atomically: write to a sibling temp file, then rename.
 *
 * On POSIX, rename is atomic on the same filesystem. A crash mid-write leaves
 * a stray temp file (cleaned up next sweep) but never a corrupted target.
 *
 * Caller must ensure the destination directory exists.
 */
export async function writeAtomic(
  path: string,
  data: Uint8Array,
): Promise<void> {
  const tmp = `${path}.tmp.${crypto.randomUUID()}`;
  await Bun.write(tmp, data);
  await rename(tmp, path);
}

export function bytesToHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

/**
 * Mask a credential for human display in logs / status pages.
 *
 * Short tokens collapse to "***". Long tokens keep the leading 8 chars
 * (the human "prefix" — matches what the admin script + backend show)
 * plus a "..." suffix.
 *
 * NEVER include the full plaintext in any printed string.
 */
export function redactToken(token: string | undefined | null): string {
  if (!token) return "(unset)";
  if (token.length <= 12) return "***";
  return `${token.slice(0, 8)}…`;
}

