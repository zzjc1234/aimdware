import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
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
};

type AuthFile = {
  providers?: Partial<Record<ProviderId, ProviderAuth>>;
};

export function createFileAuthStore(path: string): AuthStore {
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
  };
}
