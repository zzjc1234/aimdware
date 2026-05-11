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
