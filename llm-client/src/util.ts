import { rename } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where the router stages a session's blob on disk before sync.
 *
 * Returned path is identical to what `main.ts`'s onCapture writes,
 * what `buildSyncStage` reads, and what `eviction.ts` unlinks — exactly
 * three call sites that must agree on the layout, so it lives here.
 */
export function sessionBlobPath(cacheDir: string, session_id: string): string {
  return join(cacheDir, "records", `${session_id}.json`);
}

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

/**
 * Sleep that resolves immediately when stop() is called. Used by long-poll
 * worker loops so SIGTERM-driven shutdown doesn't hang on a half-finished
 * 30-minute interval.
 */
export class StoppableSleep {
  private stopped = false;
  private wake: (() => void) | null = null;

  sleep(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(t);
        this.wake = null;
        resolve();
      };
    });
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }
}


