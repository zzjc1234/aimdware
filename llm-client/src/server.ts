export type ServerOptions = {
  port: number;
  hostname: string;
};

export type ServerHandle = {
  port: number;
  hostname: string;
  stop: () => Promise<void>;
};

export type RequestHandler = (req: Request) => Promise<Response> | Response;

export async function startServer(
  opts: ServerOptions,
  handler: RequestHandler,
): Promise<ServerHandle> {
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname,
    fetch: handler,
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
