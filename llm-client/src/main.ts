#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig, type Config } from "./config";
import { createHandler } from "./handler";
import { startServer } from "./server";
import { IngestQueue } from "./queue";
import { startWorkerLoop } from "./ingest-worker";
import type { CaptureResult } from "./capture";

const ROUTER_VERSION = "0.0.0";

function expandHome(p: string): string {
  return p.startsWith("~/") || p === "~" ? join(homedir(), p.slice(1)) : p;
}

function bytesToHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

function buildIngestBody(config: Config, r: CaptureResult) {
  return {
    record_id: r.record_id,
    course_code: config.course,
    blob_hash: bytesToHex(r.blob_hash),
    blob_uri: `${config.jbox_remote_path}/${r.record_id}.json`,
    blob_size: r.blob_size,
    ts: r.ts.toISOString(),
    router_version: ROUTER_VERSION,
    client_meta: {
      upstream_type: config.upstream.type,
    },
  };
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      config: { type: "string", short: "c", default: "./aimdware.yaml" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log("Usage: aimdware-router [--config <path>]");
    return;
  }

  const configPath = values.config!;
  let yamlText: string;
  try {
    yamlText = await readFile(configPath, "utf-8");
  } catch (e) {
    console.error(`failed to read config at ${configPath}:`, (e as Error).message);
    process.exit(1);
  }

  const config = loadConfig(yamlText);
  const cacheDir = expandHome(config.local_cache_dir);
  await mkdir(cacheDir, { recursive: true });
  const queueDb = join(cacheDir, "queue.db");

  const queue = new IngestQueue(queueDb);

  const handler = createHandler({
    upstream: {
      base_url: config.upstream.base_url,
      api_key: config.upstream.api_key,
    },
    onCapture: (result) => {
      const body = buildIngestBody(config, result);
      queue.enqueue(body, Date.now());
      const hex = bytesToHex(result.blob_hash).slice(0, 16);
      console.log(
        `captured record=${result.record_id} hash=${hex}… size=${result.blob_size} -> queued`,
      );
    },
  });

  const handle = await startServer(
    { port: config.port, hostname: "127.0.0.1" },
    handler,
  );

  const worker = startWorkerLoop(
    {
      queue,
      backendUrl: config.backend_url,
      studentToken: config.student_token,
    },
    1000,
  );

  console.log(
    `aimdware-router listening on http://${handle.hostname}:${handle.port}`,
  );
  console.log(`  upstream:    ${config.upstream.base_url} (${config.upstream.type})`);
  console.log(`  course:      ${config.course}`);
  console.log(`  backend:     ${config.backend_url}`);
  console.log(`  cache:       ${cacheDir}`);

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, stopping`);
    await handle.stop();
    await worker.stop();
    queue.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.main) {
  await main();
}
