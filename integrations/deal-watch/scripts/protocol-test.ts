/** Local cross-repository check: bun scripts/protocol-test.ts /path/to/apps/deal-watch */
import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import { Worker } from "../src/worker.ts";
import { parseSony } from "../src/adapters.ts";
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
  if (deliveries !== 0) throw new Error("Sony unknown fees incorrectly delivered");
  clock += 120000;
  stock = "outOfStock";
  await worker.runOnce();
  clock += 120000;
  stock = "inStock";
  await worker.runOnce();
  if (Number(deliveries) !== 0) throw new Error("Sony restock bypassed the unknown-cost gate");
  const events = db.query("SELECT status,message_id FROM outbox").all();
  if (events.length !== 0) throw new Error("Sony unknown fees incorrectly enqueued");
  const source = store.dashboard(clock).watches[0]!.sources.find((s: any) => s.id === "sony-console");
  if (
    !source ||
    source.offers.length !== 1 ||
    source.offers[0].offer.feesCents !== null ||
    source.offers[0].qualification.eligible ||
    !source.offers[0].qualification.reasons.includes("Shipping or mandatory fees unknown")
  )
    throw new Error("Sony canonical unknown-cost evidence did not survive app ingestion");
  console.log(
    JSON.stringify({
      result: "pass",
      policyVersion: POLICY_VERSION,
      canonicalChecks: 3,
      deliveredMockEvents: deliveries,
      unknownSonyFeesRemainIneligible: true,
      vendorModulesIdentical: true,
    }),
  );
} finally {
  Date.now = realNow;
  db.close();
}

// Isolated synthetic cost evidence preserves the real app's positive outbox
// acknowledgement contract. This is not evidence of actual Sony checkout fees.
{
  const config = structuredClone(watches),
    watch = config[0]!,
    binding = watch.bindings.find((b: any) => b.retailer === "sony")!,
    database = openDb(":memory:"),
    state = new Store(database, config),
    handler = createHandler(database, state);
  const time = realNow(),
    messageId = "424242";
  let deliveries = 0,
    retailerRequests = 0;
  Date.now = () => time;
  try {
    const synthetic = JSON.parse(JSON.stringify(snapshot));
    synthetic.products[0].stock.stockLevelStatus = "inStock";
    const offer = {
      ...parseSony(JSON.stringify(synthetic), watch, binding, time),
      feesCents: 0, // Deliberately synthetic, never added by the production parser.
    };
    const post = async (path: string, body: unknown) => {
      const response = await handler(new Request(`https://app.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
      if (!response.ok) throw new Error(`Synthetic app request failed: ${response.status}`);
      return response.json();
    };
    const { lease } = await post("/api/checks/claim", { watchId: watch.id, bindingId: binding.id });
    if (!lease) throw new Error("Synthetic observation did not obtain a check lease");
    await post("/api/checks/complete", {
      watchId: watch.id, bindingId: binding.id, leaseId: lease.leaseId,
      policyVersion: state.policyVersion, offer,
    });
    const worker = new Worker({
      baseUrl: "https://app.test",
      watches: config,
      webhook: "https://discord.com/api/webhooks/123/testing-placeholder-not-a-real-token",
      now: () => time,
      fetcher: async (req) => {
        const url = new URL(req.url);
        if (url.hostname === "app.test") return handler(req);
        if (url.hostname !== "discord.com") {
          retailerRequests++;
          throw new Error("No retailer request expected in synthetic acknowledgement phase");
        }
        deliveries++;
        return Response.json({ id: messageId });
      },
    });
    worker.cache.set(`${watch.id}/${binding.id}`, new Map([[offer.id, offer]]));
    await worker.runOnce();
    const events = database.query("SELECT status,message_id FROM outbox").all() as { status: string; message_id: string }[];
    if (retailerRequests !== 0 || deliveries !== 1 || events.length !== 1 || events[0]!.status !== "sent" || events[0]!.message_id !== messageId)
      throw new Error("Synthetic delivery did not persist the real app acknowledgement");
    console.log(JSON.stringify({ result: "pass", syntheticKnownCostEvidence: true,
      deliveredMockEvents: deliveries, durableAcknowledgement: true, retailerRequests }));
  } finally {
    Date.now = realNow;
    database.close();
  }
}

// Exercise the actual app's durable eBay task contract using synthetic API data.
{
  const { EbayClient } = await import("../src/ebay.ts");
  const config = structuredClone(watches);
  config[0]!.bindings = [
    {
      id: "ebay-synthetic",
      retailer: "ebay",
      productId: "1234567890123",
      ebayGtin: "1234567890123",
      pagePath: "/sch/i.html",
      enabled: true,
      note: "Synthetic protocol fixture",
    },
  ];
  const database = openDb(":memory:"),
    state = new Store(database, config),
    handler = createHandler(database, state);
  const ids = ["v1|123456789012|0", "v1|123456789013|0"];
  let time = realNow(),
    reads = 0;
  Date.now = () => time;
  const fetcher = async (req: Request) => {
    const url = new URL(req.url);
    if (url.hostname === "app.test") return handler(req);
    if (url.hostname !== "api.ebay.com") throw Error("Unexpected synthetic host");
    if (req.method === "POST")
      return Response.json({
        access_token: "synthetic-access-token",
        expires_in: 7200,
        token_type: "Application Access Token",
      });
    reads++;
    if (url.pathname.endsWith("/search"))
      return Response.json({ itemSummaries: ids.map((itemId) => ({ itemId })) });
    return Response.json({
      itemId: decodeURIComponent(url.pathname.split("/").at(-1)!),
      gtin: "1234567890123",
      title: "Synthetic console",
      conditionId: "1000",
      buyingOptions: ["FIXED_PRICE"],
      price: { value: "500.00", currency: "USD" },
      seller: { username: "Synthetic seller", feedbackPercentage: "99.9", feedbackScore: 1000 },
    });
  };
  try {
    const worker = new Worker({
      baseUrl: "https://app.test",
      watches: config,
      fetcher,
      startupDelay: false,
      now: () => time,
      random: () => 0,
      ebay: new EbayClient(
        { clientId: "synthetic-client", clientSecret: "synthetic-secret" },
        fetcher,
        () => time,
      ),
    });
    await worker.runOnce();
    time += 300000;
    await worker.runOnce();
    time += 300000;
    await worker.runOnce();
    const source = state.dashboard(time).watches[0]!.sources[0]!;
    if (
      reads !== 3 ||
      source.offers.length !== 2 ||
      source.offers.some((o: any) => o.qualification.eligible)
    )
      throw Error("eBay protocol or unknown-cost gate failed");
    console.log(
      JSON.stringify({
        result: "pass",
        syntheticEbayRequests: reads,
        independentOffers: source.offers.length,
        unknownCostsRemainIneligible: true,
      }),
    );
  } finally {
    Date.now = realNow;
    database.close();
  }
}
