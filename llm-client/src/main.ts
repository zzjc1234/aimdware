#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config";
import { createHandler } from "./handler";
import { startServer } from "./server";

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

  const handler = createHandler({
    upstream: { base_url: config.upstream.base_url, api_key: config.upstream.api_key },
    onCapture: (result) => {
      // Phase 1 stub: replaced by ingest + jbox sync in later phases.
      const hex = Buffer.from(result.blob_hash).toString("hex").slice(0, 16);
      console.log(
        `captured record=${result.record_id} hash=${hex}… size=${result.blob_size}`,
      );
    },
  });

  const handle = await startServer(
    { port: config.port, hostname: "127.0.0.1" },
    handler,
  );

  console.log(
    `aimdware-router listening on http://${handle.hostname}:${handle.port}`,
  );
  console.log(`  upstream:    ${config.upstream.base_url} (${config.upstream.type})`);
  console.log(`  course:      ${config.course}`);
  console.log(`  backend:     ${config.backend_url}`);

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, stopping`);
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.main) {
  await main();
}
