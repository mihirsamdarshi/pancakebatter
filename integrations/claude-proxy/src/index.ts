import { configFromEnv, createHandler, MAX_BODY_BYTES } from "./proxy.ts";

// The only upstream. The network policy allows any public address on 443
// (the cluster has no FQDN rules), so this constant is what keeps the API key
// going to Anthropic and nowhere else.
const UPSTREAM = "https://api.anthropic.com";

const config = configFromEnv(process.env);
const handler = createHandler(UPSTREAM, config);
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  hostname: "0.0.0.0",
  idleTimeout: 75,
  maxRequestBodySize: MAX_BODY_BYTES,
  fetch: handler.fetch,
});
console.log(
  JSON.stringify({
    time: new Date().toISOString(),
    event: "listening",
    port: server.port,
    allowedModels: config.allowedModels,
    dailyCapUsd: config.dailyCapUsd,
    maxConcurrent: config.maxConcurrent,
  }),
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    // Stop accepting connections; requests in flight finish first.
    void server.stop();
  });
