import { readWebhook } from "./discord.ts";
import { readPolicy } from "./policy.ts";
import { EbayClient, readEbayCredentials } from "./ebay.ts";
import { Worker } from "./worker.ts";
const baseUrl = process.env.APP_BASE_URL;
if (!baseUrl) throw new Error("APP_BASE_URL is required");
const webhook = process.env.DISCORD_WEBHOOK_FILE
  ? readWebhook(process.env.DISCORD_WEBHOOK_FILE)
  : undefined;
const watches = readPolicy(process.env.WATCH_CONFIG_FILE ?? "/run/credentials/watch-policy.json");
const worker = new Worker({
  baseUrl,
  ebay: process.env.EBAY_CREDENTIALS_FILE
    ? new EbayClient(readEbayCredentials(process.env.EBAY_CREDENTIALS_FILE))
    : undefined,
  webhook,
  browserUrl: process.env.BROWSER_URL || undefined,
  ebayStateUrl: process.env.EBAY_STATE_URL || undefined,
  watches,
  allowLocalHttp: process.env.ALLOW_LOCAL_HTTP === "1",
});
let stopping = false;
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  hostname: "0.0.0.0",
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path !== "/healthz") return new Response("not found", { status: 404 });
    return Response.json(
      {
        collectorReady: Date.now() - worker.lastSuccessfulCycle < 120_000,
        discordConfigured: !!webhook,
      },
      { status: Date.now() - worker.lastSuccessfulCycle < 120_000 ? 200 : 503 },
    );
  },
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    stopping = true;
  });
while (!stopping) {
  try {
    const counts = await worker.runOnce();
    console.log(JSON.stringify({ event: "cycle", ...counts }));
  } catch {
    console.error(JSON.stringify({ event: "cycle-failed" }));
  }
  if (process.env.RUN_ONCE === "1") break;
  await Bun.sleep(15_000 + Math.random() * 5_000);
}
await server.stop();
