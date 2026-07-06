// One worker process of the cross-process codex-refresh concurrency test.
// Spawned by run.ts; talks to a fake OAuth server and shares one auth.json
// with its siblings. See run.ts for the harness and assertions.
import { createCodexProvider } from "../../llm-client/src/providers/codex.ts";
import {
  authFilePath,
  createFileAuthStore,
} from "../../llm-client/src/providers/auth-store.ts";

const cacheDir = process.argv[2]!;
const oauthPort = Number(process.argv[3]);
const mode = process.argv[4] ?? "lock";
const barrierPort = Number(process.argv[5]);

// Block at the barrier so every sibling fires its refresh simultaneously
// instead of being staggered by process startup.
await fetch(`http://127.0.0.1:${barrierPort}/`).catch(() => {});

const base = createFileAuthStore(authFilePath(cacheDir));
// "nolock" strips withLock so codex falls back to its in-process-only path,
// reproducing the behaviour from before the cross-process file lock existed.
const store: any =
  mode === "nolock"
    ? { get: base.get, set: base.set, del: base.del }
    : base;

const fetchImpl = async (input: any, init: any) => {
  const u = new URL(String(input));
  // Talk to the local fake OAuth server, ignoring any proxy from the env.
  const rest = { ...init };
  delete rest.proxy;
  return fetch(`http://127.0.0.1:${oauthPort}${u.pathname}`, rest);
};

const provider = createCodexProvider({ authStore: store, fetchImpl });
try {
  const prepared = await provider.prepareResponses({
    inboundUrl: new URL("http://x/v1/responses"),
    method: "POST",
    headers: new Headers(),
    body: undefined,
  } as any);
  console.log("OK " + prepared.headers.get("authorization"));
  process.exit(0);
} catch (e: any) {
  console.log("ERR " + (e?.message ?? e));
  process.exit(2);
}
