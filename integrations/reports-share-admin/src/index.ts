import { configFromEnv } from "./config.ts";
import { createHandler, createHealthHandler, internalError, stdoutLogger } from "./handler.ts";
import { MAX_BODY_BYTES } from "./schemas.ts";

// The only upstream. The network policy allows Cloudflare's address ranges on
// 443, so this constant is what keeps the API token going to Cloudflare only.
const UPSTREAM = "https://api.cloudflare.com/client/v4";

const config = configFromEnv(process.env);
const handler = createHandler(UPSTREAM, config);
const server = Bun.serve({
  port: config.port,
  hostname: "0.0.0.0",
  // A write is a read plus a check plus a write, each up to 15 seconds.
  idleTimeout: 60,
  maxRequestBodySize: MAX_BODY_BYTES,
  fetch: handler.fetch,
  // No stack trace in an answer, whatever goes wrong.
  error: () => internalError(),
});
// The probe port serves /healthz and nothing else.
const health = createHealthHandler(config);
const healthServer = Bun.serve({
  port: config.healthPort,
  hostname: "0.0.0.0",
  idleTimeout: 10,
  fetch: health.fetch,
  error: () => internalError(),
});
stdoutLogger({
  event: "listening",
  port: server.port,
  healthPort: healthServer.port,
  allowedHosts: config.allowedHosts,
  notifications: config.resendKeyFile !== undefined,
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    // Stop accepting connections; requests in flight finish first.
    void server.stop();
    void healthServer.stop();
  });
