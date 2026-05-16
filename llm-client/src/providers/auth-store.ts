import { mkdir, readFile } from "node:fs/promises";
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

  return {
    async get(id) {
      return (await readAll()).providers?.[id];
    },
    async set(id, auth) {
      const file = await readAll();
      const next: AuthFile = {
        ...file,
        providers: {
          ...file.providers,
          [id]: auth,
        },
      };
      await mkdir(dirname(path), { recursive: true });
      await writeAtomic(path, new TextEncoder().encode(JSON.stringify(next)));
    },
  };
}
