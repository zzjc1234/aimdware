import { test, expect, afterEach } from "bun:test";
import { startServer, type ServerHandle } from "./server";

let handle: ServerHandle | undefined;

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
});

test("startServer delegates fetch to the provided handler", async () => {
  handle = await startServer(
    { port: 0, hostname: "127.0.0.1" },
    async (req) => new Response(`echo: ${new URL(req.url).pathname}`, { status: 200 }),
  );

  const res = await fetch(`http://127.0.0.1:${handle.port}/anything`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("echo: /anything");
});

test("server binds to the requested hostname", async () => {
  handle = await startServer(
    { port: 0, hostname: "127.0.0.1" },
    () => new Response("ok"),
  );
  expect(handle.hostname).toBe("127.0.0.1");
});

test("server.stop is idempotent", async () => {
  handle = await startServer(
    { port: 0, hostname: "127.0.0.1" },
    () => new Response("ok"),
  );
  await handle.stop();
  await handle.stop();
});
