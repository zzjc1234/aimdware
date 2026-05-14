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
assignment: hw1
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
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
  });
  procs.push(proc);

  try {
    await waitForPort(routerPort);

    const res = await fetch(
      `http://127.0.0.1:${routerPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"id":"upstream-ok"}');
  } finally {
    proc.kill();
    await fakeUpstream.stop(true);
  }
});

test("main: never prints plaintext student_token or upstream api_key", async () => {
  const fakeUpstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response('{"id":"x"}', { status: 200 }),
  });
  const routerPort = await pickFreePort();
  const tmp = await mkdtemp(join(tmpdir(), "aimdware-redact-"));
  tmpDirs.push(tmp);

  const STUDENT = "st_DO_NOT_LOG_ME_THIS_IS_LONG_AND_OBVIOUS_zzzz";
  const APIKEY = "sk-DO_NOT_LOG_ME_EITHER_zzzz";

  const configPath = join(tmp, "aimdware.yaml");
  await writeFile(
    configPath,
    `
student_token: ${STUDENT}
course: ECE4721J
assignment: hw1
upstream:
  base_url: http://127.0.0.1:${fakeUpstream.port}
  api_key: ${APIKEY}
port: ${routerPort}
local_cache_dir: ${tmp}/cache
backend_url: http://127.0.0.1:1
`,
  );

  const proc = spawn({
    cmd: ["bun", "run", "src/main.ts", "--config", configPath],
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
  });
  procs.push(proc);

  // Drain stdout/stderr CONCURRENTLY — otherwise the pipe fills and the
  // child blocks on console.log.
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  const drainStdout = (async () => {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      stdoutChunks.push(chunk);
    }
  })();
  const drainStderr = (async () => {
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      stderrChunks.push(chunk);
    }
  })();

  try {
    await waitForPort(routerPort);

    await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    }).then((r) => r.text());

    await Bun.sleep(100);
    proc.kill();
    await Promise.race([proc.exited, Bun.sleep(2000)]);
    await Promise.all([drainStdout, drainStderr]);

    const decode = (cs: Uint8Array[]) =>
      Buffer.concat(cs.map((c) => Buffer.from(c))).toString("utf-8");
    const combined = decode(stdoutChunks) + decode(stderrChunks);

    expect(combined).not.toContain(STUDENT);
    expect(combined).not.toContain(APIKEY);
    // Sanity: the redacted prefix should appear (proves we did log
    // *something* about the token).
    expect(combined).toContain(STUDENT.slice(0, 8));
    expect(combined).toContain(APIKEY.slice(0, 8));
  } finally {
    await fakeUpstream.stop(true);
  }
});
