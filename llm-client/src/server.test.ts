import { test, expect, afterEach } from "bun:test";
import { startServer, type ServerHandle } from "./server";

let handle: ServerHandle | undefined;

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
});

test("GET /healthz returns 200 ok", async () => {
  handle = await startServer({ port: 0, hostname: "127.0.0.1" });

  const res = await fetch(`http://127.0.0.1:${handle.port}/healthz`);

  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

test("server binds to 127.0.0.1 only (not 0.0.0.0)", async () => {
  handle = await startServer({ port: 0, hostname: "127.0.0.1" });
  expect(handle.hostname).toBe("127.0.0.1");
});
