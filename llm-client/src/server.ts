export type ServerOptions = {
  port: number;
  hostname: string;
};

export type ServerHandle = {
  port: number;
  hostname: string;
  stop: () => Promise<void>;
};

export async function startServer(
  opts: ServerOptions,
): Promise<ServerHandle> {
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return new Response("ok", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  if (server.port === undefined) {
    throw new Error("server.port unexpectedly undefined (unix socket?)");
  }
  return {
    port: server.port,
    hostname: opts.hostname,
    stop: async () => {
      await server.stop(true);
    },
  };
}
