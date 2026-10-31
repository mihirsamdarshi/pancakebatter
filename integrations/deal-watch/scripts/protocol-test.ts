/** Local cross-repository check: bun scripts/protocol-test.ts /path/to/apps/deal-watch */
import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import { Worker } from "../src/worker.ts";
import { POLICY_VERSION } from "../src/vendor/domain.ts";
const app = resolve(process.argv[2] ?? "");
for (const file of ["domain.ts"]) {
  if (
    readFileSync(join(app, "src", file), "utf8") !==
    readFileSync(new URL(`../src/vendor/${file}`, import.meta.url), "utf8")
  )
    throw new Error(`Shared contract mismatch: ${file}`);
}
const { watches } = await import(join(app, "src/config.ts"));
const { openDb, Store } = await import(join(app, "src/db.ts"));
const { createHandler } = await import(join(app, "src/app.ts"));
const db = openDb(":memory:"),
  store = new Store(db),
  handle = createHandler(db, store),
  snapshot = JSON.parse(
    readFileSync(new URL("../fixtures/sony-out-of-stock.json", import.meta.url), "utf8"),
  );
const realNow = Date.now;
let clock = realNow(),
  stock = "inStock",
  deliveries = 0;
Date.now = () => clock;
try {
  const worker = new Worker({
    baseUrl: "https://app.test",
    watches,
    webhook: "https://discord.com/api/webhooks/123/testing-placeholder-not-a-real-token",
    startupDelay: false,
    now: () => clock,
    random: () => 0,
    fetcher: async (req) => {
      const url = new URL(req.url);
      if (url.hostname === "app.test") return handle(req);
      if (url.hostname === "api.direct.playstation.com") {
        snapshot.products[0].stock.stockLevelStatus = stock;
        return Response.json(snapshot);
      }
      if (url.hostname === "discord.com") {
        deliveries++;
        return Response.json({ id: String(1000 + deliveries) });
      }
      throw new Error("Unexpected host");
    },
  });
  await worker.runOnce();
  if (deliveries !== 1) throw new Error("First qualifying event did not deliver");
  clock += 120000;
  stock = "outOfStock";
  await worker.runOnce();
  clock += 120000;
  stock = "inStock";
  await worker.runOnce();
  if (Number(deliveries) !== 2) throw new Error("Restock episode did not rearm");
  const events = db.query("SELECT status,message_id FROM outbox").all();
  if (events.length !== 2 || events.some((e: { status: string }) => e.status !== "sent"))
    throw new Error("Durable delivery acknowledgement failed");
  console.log(
    JSON.stringify({
      result: "pass",
      policyVersion: POLICY_VERSION,
      canonicalChecks: 3,
      deliveredMockEvents: deliveries,
      vendorModulesIdentical: true,
    }),
  );
} finally {
  Date.now = realNow;
  db.close();
}
