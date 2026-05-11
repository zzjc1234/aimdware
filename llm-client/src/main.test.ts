import { test, expect, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const procs: Subprocess[] = [];
const tmpDirs: string[] = [];

afterAll(async () => {
  for (const p of procs) p.kill();
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

async function waitForPort(port: number, host = "127.0.0.1", timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${host}:${port}/healthz`);
      if (res.status === 200) return;
    } catch {
      /* not ready */
    }
    await Bun.sleep(50);
  }
  throw new Error(`port ${port} not ready within ${timeoutMs}ms`);
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(""),
    });
    const port = s.port!;
    s.stop(true).then(() => resolve(port));
  });
}

test("main: serves /healthz and proxies a chat completion end-to-end", async () => {
  const fakeUpstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response('{"id":"upstream-ok"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  const routerPort = await pickFreePort();

  const tmp = await mkdtemp(join(tmpdir(), "aimdware-e2e-"));
  tmpDirs.push(tmp);
  const configPath = join(tmp, "aimdware.yaml");
  await writeFile(
    configPath,
    `
student_token: st_test
course: ECE4721J
upstream:
  base_url: http://127.0.0.1:${fakeUpstream.port}
  api_key: sk-test
port: ${routerPort}
local_cache_dir: ${tmp}/cache
backend_url: http://127.0.0.1:1
`,
  );

  const proc = spawn({
    cmd: ["bun", "run", "src/main.ts", "--config", configPath],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  procs.push(proc);

  try {
    await waitForPort(routerPort);

    const res = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"id":"upstream-ok"}');
  } finally {
    proc.kill();
    await fakeUpstream.stop(true);
  }
});
