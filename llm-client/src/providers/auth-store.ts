import { chmod, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeAtomic } from "../util";
import type { ProviderId } from "./plugin";

export type OAuthAuth = {
  type: "oauth";
  access?: string;
  refresh: string;
  expires: number;
  account_id?: string;
  accountId?: string;
  enterprise_url?: string;
  enterpriseUrl?: string;
};

export type ProviderAuth = OAuthAuth;

export type AuthStore = {
  get(id: ProviderId): Promise<ProviderAuth | undefined>;
  set(id: ProviderId, auth: ProviderAuth): Promise<void>;
  del(id: ProviderId): Promise<void>;
  // Run `fn` while holding a cross-process lock on the credential store, so a
  // read-modify-write (e.g. a token refresh) is atomic across router processes
  // sharing the same cache. Optional: stores with no shared backing (in-memory
  // test doubles) need no lock and may omit it.
  withLock?<T>(fn: () => Promise<T>): Promise<T>;
};

type AuthFile = {
  providers?: Partial<Record<ProviderId, ProviderAuth>>;
};

/**
 * Location of the credential file given the router's cache dir.
 *
 * Credentials live in their own subdirectory so the store can lock it to 0700
 * without touching the shared cache dir (which also holds records/ + queue.db,
 * may be a symlink, or may not be owned by this user).
 */
export function authFilePath(cacheDir: string): string {
  return join(cacheDir, "auth", "auth.json");
}

export function createFileAuthStore(
  path: string,
  opts?: { lockStaleMs?: number; lockPollMs?: number },
): AuthStore {
  const lockPath = `${path}.lock`;
  const lockStaleMs = opts?.lockStaleMs ?? 30_000;
  const lockPollMs = opts?.lockPollMs ?? 50;

  async function readAll(): Promise<AuthFile> {
    try {
      return JSON.parse(await readFile(path, "utf-8")) as AuthFile;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
  }

  // Serialize mutations through a promise chain: set/del are read-modify-write,
  // so concurrent callers would otherwise race on readAll() and clobber each
  // other's provider entry. A failed write must not break the chain for later
  // writers, hence the `.catch`.
  let writeChain: Promise<void> = Promise.resolve();
  function mutate(transform: (file: AuthFile) => AuthFile): Promise<void> {
    const run = writeChain.then(async () => {
      const next = transform(await readAll());
      const dir = dirname(path);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      // mkdir's mode only applies to dirs it creates; tighten an existing one
      // (e.g. a cache dir made earlier with default perms) so the credential
      // file's directory is never group/world-traversable.
      await chmod(dir, 0o700);
      await writeAtomic(path, new TextEncoder().encode(JSON.stringify(next)), {
        mode: 0o600,
      });
    });
    writeChain = run.catch(() => {});
    return run;
  }

  return {
    async get(id) {
      return (await readAll()).providers?.[id];
    },
    set(id, auth) {
      return mutate((file) => ({
        ...file,
        providers: { ...file.providers, [id]: auth },
      }));
    },
    del(id) {
      return mutate((file) => {
        const providers = { ...file.providers };
        delete providers[id];
        return { ...file, providers };
      });
    },
    async withLock(fn) {
      await acquireLock();
      try {
        return await fn();
      } finally {
        await unlink(lockPath).catch(() => {});
      }
    },
  };

  // Cross-process mutex via an exclusive-create lock file. A holder that
  // crashed leaves the file behind; the next acquirer reclaims it once the
  // file is older than `lockStaleMs`.
  async function acquireLock(): Promise<void> {
    while (true) {
      try {
        await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
        const handle = await open(lockPath, "wx", 0o600);
        await handle.close();
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try {
          const st = await stat(lockPath);
          if (Date.now() - st.mtimeMs > lockStaleMs) {
            await unlink(lockPath).catch(() => {});
            continue;
          }
        } catch {
          continue; // lock vanished between open and stat; retry immediately
        }
        await new Promise((r) => setTimeout(r, lockPollMs));
      }
    }
  }
}
