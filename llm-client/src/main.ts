#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig, type Config } from "./config";
import { createHandler } from "./http/handler";
import { startServer } from "./http/server";
import { authFilePath, createFileAuthStore } from "./providers/auth-store";
import type { AuthStore } from "./providers/auth-store";
import { loginCodexDevice } from "./providers/auth-login";
import { createProvider } from "./providers";
import { IngestQueue } from "./outbox/queue";
import {
  startWorkerLoop,
  type Stages,
  type StageHandler,
} from "./outbox/relay";
import {
  postContext,
  confirmUploaded,
  type IngestBody,
} from "./outbox/ingest-client";
import { syncBlob, makeWebDAVPut, type WebDAVPutLike } from "./outbox/sync";
import { writeAtomic, bytesToHex, redactToken, sessionBlobPath } from "./util";
import {
  PendingSessionWrites,
  runSessionCacheCleanupOnce,
  startEvictionLoop,
} from "./outbox/eviction";
import { tryParseJSON, decodeBytes } from "./recording/capture";
import { SessionTracker, type Message } from "./recording/session";
import { buildSessionBlob } from "./recording/session-blob";
import pkg from "../package.json" with { type: "json" };

const ROUTER_VERSION = pkg.version;

function expandHome(p: string): string {
  return p.startsWith("~/") || p === "~" ? join(homedir(), p.slice(1)) : p;
}

export function extractMessages(requestBytes: Uint8Array): Message[] {
  const parsed = tryParseJSON(decodeBytes(requestBytes));
  if (parsed && typeof parsed === "object") {
    const messages = (parsed as { messages?: unknown }).messages;
    if (Array.isArray(messages)) return messages as Message[];
    const input = (parsed as { input?: unknown }).input;
    if (Array.isArray(input)) return input as Message[];
  }
  return [];
}

async function runAuthCommand(
  positionals: string[],
  authStore: AuthStore,
): Promise<boolean> {
  if (positionals[0] !== "auth") return false;
  const action = positionals[1];
  const provider = positionals[2];

  if (action === "status") {
    for (const id of ["codex"] as const) {
      const auth = await authStore.get(id);
      if (!auth) {
        console.log(`${id}: not logged in`);
        continue;
      }
      console.log(
        `${id}: logged in token=${redactToken(auth.access ?? auth.refresh)}`,
      );
    }
    return true;
  }

  if (action === "login" && provider === "codex") {
    await loginCodexDevice({ authStore });
    console.log("codex: logged in");
    return true;
  }

  throw new Error(
    "unknown auth command; expected `auth status` or `auth login codex`",
  );
}

/**
 * Read the session's cached blob from disk and PUT it to jbox. The file
 * is shared across all turns of the session — if a newer turn overwrote
 * it before this worker fired, that newer state is what gets uploaded.
 * The older turn's `blob_hash` stored in the backend will then fail
 * verification against the on-jbox bytes; this is documented in
 * `BlobStatus`.
 */
export function buildSyncStage(
  cacheDir: string,
  webdavPut: WebDAVPutLike,
): StageHandler {
  return async (body) => {
    const path = sessionBlobPath(cacheDir, body.session_id);
    let data: Uint8Array;
    try {
      data = new Uint8Array(await Bun.file(path).arrayBuffer());
    } catch (e) {
      return {
        kind: "terminal",
        finalState: "fatal",
        reason: `cache file missing: ${(e as Error).message}`,
      };
    }
    const r = await syncBlob(webdavPut, "/" + body.blob_uri, data);
    switch (r.kind) {
      case "synced":
        return { kind: "advance" };
      case "fatal":
        return { kind: "terminal", finalState: "fatal", reason: r.reason };
      case "retryable":
        return { kind: "retry", reason: r.reason };
    }
  };
}

function buildStages(
  config: Config,
  cacheDir: string,
  webdavPut: WebDAVPutLike,
): Stages {
  const ingest: StageHandler = async (body) => {
    const r = await postContext(config.backend_url, config.student_token, body);
    switch (r.kind) {
      case "created":
      case "exists":
        return { kind: "advance" };
      case "conflict":
        return {
          kind: "terminal",
          finalState: "conflict",
          reason: "body mismatch",
        };
      case "fatal":
        return { kind: "terminal", finalState: "fatal", reason: r.reason };
      case "retryable":
        return { kind: "retry", reason: r.reason };
    }
  };

  const confirm: StageHandler = async (body) => {
    const r = await confirmUploaded(
      config.backend_url,
      config.student_token,
      body.record_id,
    );
    switch (r.kind) {
      case "ok":
        return { kind: "advance" };
      case "fatal":
        return { kind: "terminal", finalState: "fatal", reason: r.reason };
      case "retryable":
        return { kind: "retry", reason: r.reason };
    }
  };

  return { ingest, sync: buildSyncStage(cacheDir, webdavPut), confirm };
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      config: { type: "string", short: "c", default: "./aimdware.yaml" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`aimdware-router ${ROUTER_VERSION}

Usage:
  aimdware-router --config <path>          start the router
  aimdware-router --config <path> auth status
  aimdware-router --config <path> auth login codex
  aimdware-router --help                   show this message

The config file is a YAML doc. See aimdware.example.yaml for the
expected fields (student_token, course, backend_url, tbox_*, upstream).`);
    return;
  }

  const configPath = values.config!;
  let yamlText: string;
  try {
    yamlText = await readFile(configPath, "utf-8");
  } catch (e) {
    console.error(
      `failed to read config at ${configPath}:`,
      (e as Error).message,
    );
    process.exit(1);
  }

  const config = loadConfig(yamlText);
  const cacheDir = expandHome(config.local_cache_dir);
  await mkdir(join(cacheDir, "records"), { recursive: true });
  const queueDb = join(cacheDir, "queue.db");
  const authStore = createFileAuthStore(authFilePath(cacheDir));

  try {
    if (await runAuthCommand(positionals, authStore)) {
      return;
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const queue = new IngestQueue(queueDb);
  const sessionTracker = new SessionTracker();
  const pendingCacheWrites = new PendingSessionWrites();
  const provider = createProvider(config.upstream, authStore);
  const webdavPut = makeWebDAVPut(
    config.tbox_url,
    config.tbox_user
      ? { username: config.tbox_user, password: config.tbox_pass }
      : undefined,
  );

  const handler = createHandler({
    upstream: provider,
    onCapture: async (result) => {
      const messages = extractMessages(result.request_bytes);
      const cls = sessionTracker.classify(messages, result.ts);

      const blob = buildSessionBlob({
        session_id: cls.session_id,
        course: config.course,
        assignment: config.assignment,
        started_at: cls.started_at,
        latest_ts: result.ts,
        turn_count: cls.turn_count,
        upstream_type: config.upstream.type,
        upstream_status: result.upstream_status,
        request_bytes: result.request_bytes,
        response_bytes: result.response_bytes,
      });

      const blobPath = sessionBlobPath(cacheDir, cls.session_id);
      pendingCacheWrites.begin(cls.session_id);
      try {
        try {
          await writeAtomic(blobPath, blob.blob_bytes);
        } catch (e) {
          console.error(
            `cache write failed for record=${result.record_id} session=${cls.session_id}:`,
            (e as Error).message,
          );
          return;
        }

        const body: IngestBody = {
          record_id: result.record_id,
          session_id: cls.session_id,
          turn_count: cls.turn_count,
          course_code: config.course,
          assignment: config.assignment,
          blob_hash: bytesToHex(blob.blob_hash),
          blob_uri: `${config.jbox_remote_path}/${cls.session_id}.json`,
          blob_size: blob.blob_size,
          ts: result.ts.toISOString(),
          router_version: ROUTER_VERSION,
          client_meta: { upstream_type: config.upstream.type },
        };
        queue.enqueue(body, Date.now());
        const hex = bytesToHex(blob.blob_hash).slice(0, 16);
        console.log(
          `captured record=${result.record_id} session=${cls.session_id} turn=${cls.turn_count} hash=${hex}… size=${blob.blob_size} -> queued`,
        );
      } finally {
        pendingCacheWrites.end(cls.session_id);
      }
    },
  });

  const handle = await startServer(
    { port: config.port, hostname: "127.0.0.1" },
    handler,
  );

  const worker = startWorkerLoop(
    {
      queue,
      stages: buildStages(config, cacheDir, webdavPut),
      concurrency: 4,
      afterAdvance: async (body, from, to) => {
        if (from === "ingested" && to === "synced") {
          await runSessionCacheCleanupOnce({
            queue,
            cacheDir,
            session_id: body.session_id,
            isSessionPending: pendingCacheWrites.has,
          });
        }
      },
    },
    1000,
  );

  const eviction = startEvictionLoop({
    queue,
    cacheDir,
    isSessionPending: pendingCacheWrites.has,
  });

  console.log(
    `aimdware-router listening on http://${handle.hostname}:${handle.port}`,
  );
  console.log(`  upstream:    ${provider.label} (${provider.id})`);
  if (config.upstream.plugin === "openai") {
    console.log(`  upstream url: ${config.upstream.base_url}`);
    console.log(`  upstream key: ${redactToken(config.upstream.api_key)}`);
  } else {
    console.log(`  upstream auth: ${authFilePath(cacheDir)}`);
  }
  console.log(`  student token: ${redactToken(config.student_token)}`);
  console.log(`  course:      ${config.course}`);
  console.log(`  backend:     ${config.backend_url}`);
  console.log(`  tbox:        ${config.tbox_url}`);
  console.log(`  cache:       ${cacheDir}`);

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, stopping`);
    await handle.stop();
    await worker.stop();
    await eviction.stop();
    queue.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.main) {
  await main();
}
