import { configFromEnv } from "./config.ts";
import { createHandler, stdoutLogger } from "./handler.ts";
import { MAX_BODY_BYTES } from "./schemas.ts";

// The only upstream. The network policy allows Cloudflare's address ranges on
// 443, so this constant is what keeps the API token going to Cloudflare only.
const UPSTREAM = "https://api.cloudflare.com/client/v4";

const config = configFromEnv(process.env);
const handler = createHandler(UPSTREAM, config);
const server = Bun.serve({
  port: config.port,
  hostname: "0.0.0.0",
  idleTimeout: 30,
  maxRequestBodySize: MAX_BODY_BYTES,
  fetch: handler.fetch,
});
stdoutLogger({
  event: "listening",
  port: server.port,
  allowedHosts: config.allowedHosts,
  notifications: config.resendKeyFile !== undefined,
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    // Stop accepting connections; requests in flight finish first.
    void server.stop();
  });
