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

// Exercise Target and Best Buy through a mocked browser service: no real retailer or network access.
{
  const config = structuredClone(watches);
  const zip = config[0]!.zip;
  config[0]!.bindings = [
    {
      id: "bestbuy-console",
      retailer: "bestbuy",
      productId: "6601524",
      pagePath: "/product/playstation-5-pro-console/JXHQ37TR86/sku/6601524",
      enabled: true,
      shippingPolicyZips: [zip],
      note: "Synthetic browser protocol fixture",
    },
    {
      id: "target-console",
      retailer: "target",
      productId: "93620188",
      pagePath: "/p/-/A-93620188",
      enabled: true,
      shippingPolicyZips: [zip],
      note: "Synthetic browser protocol fixture",
    },
  ];
  const read = (name: string) =>
    JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
  const docs: Record<string, any> = {
    target: read("target-in-stock-synthetic"),
    bestbuy: read("bestbuy-in-stock-synthetic"),
  };
  const database = openDb(":memory:"),
    state = new Store(database, config),
    handler = createHandler(database, state);
  let time = realNow(),
    loads = 0;
  Date.now = () => time;
  const fetcher = async (req: Request) => {
    const url = new URL(req.url);
    if (url.hostname === "app.test") return handler(req);
    if (url.hostname !== "browser.test") throw Error("Unexpected synthetic host");
    loads++;
    return Response.json(docs[(await req.json()).retailer]);
  };
  try {
    const worker = new Worker({
      baseUrl: "https://app.test",
      watches: config,
      fetcher,
      browserUrl: "http://browser.test:3000",
      startupDelay: false,
      now: () => time,
      random: () => 0,
    });
    await worker.runOnce();
    time += 1_800_000;
    await worker.runOnce();
    const sources = state.dashboard(time).watches[0]!.sources;
    const offers = sources.flatMap((s: any) => s.offers);
    if (loads !== 4 || offers.length < 2 || !offers.every((o: any) => o.qualification.eligible))
      throw Error("Browser-backed Target/Best Buy protocol failed");
    console.log(
      JSON.stringify({
        result: "pass",
        syntheticBrowserLoads: loads,
        browserSourcesEligible: offers.length,
      }),
    );
  } finally {
    Date.now = realNow;
    database.close();
  }
}
