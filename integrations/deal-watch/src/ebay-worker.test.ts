import { expect, spyOn, test } from "bun:test";
import { Worker } from "./worker.ts";
import { EbayClient } from "./ebay.ts";
import { readPolicy } from "./policy.ts";
import { budgets, policyIdentity } from "./vendor/domain.ts";
test("worker schedules search and each detail separately, including after restart", async () => {
  const watches = readPolicy(new URL("../fixtures/example-policy.json", import.meta.url).pathname),
    w = watches[0]!;
  w.bindings = [
    {
      id: "ebay",
      retailer: "ebay",
      productId: "1234567890123",
      ebayGtin: "1234567890123",
      enabled: true,
      pagePath: "/sch/i.html",
      note: "Synthetic",
    },
  ];
  const ids = ["v1|123456789012|0", "v1|123456789013|0"];
  let now = 0,
    cursor = 2,
    browse = 0,
    mints = 0;
  const details: unknown[] = [];
  const fetcher = async (request: Request) => {
    const url = new URL(request.url);
    if (url.hostname === "receiver.test")
      return Response.json({ state: "CLEAR", storageDesignVersion: "tier1-v1", instanceId: "x" });
    if (url.hostname === "api.ebay.com") {
      if (request.method === "POST") {
        mints++;
        return Response.json({
          access_token: "synthetic",
          expires_in: 7200,
          token_type: "Application Access Token",
        });
      }
      browse++;
      if (url.pathname.endsWith("/search"))
        return Response.json({ itemSummaries: ids.map((itemId) => ({ itemId })) });
      const itemId = decodeURIComponent(url.pathname.split("/").at(-1)!);
      return Response.json({
        itemId,
        gtin: "1234567890123",
        title: "Synthetic",
        conditionId: "1000",
        buyingOptions: ["FIXED_PRICE"],
        price: { value: "500", currency: "USD" },
        seller: { username: "Synthetic", feedbackPercentage: "99.9", feedbackScore: 1000 },
      });
    }
    if (url.pathname === "/api/dashboard")
      return Response.json({
        policyVersion: policyIdentity(watches),
        watches: [{ id: w.id, preferences: { paused: false, muted: false, purchased: false } }],
      });
    if (url.pathname === "/api/checks/claim")
      return Response.json({
        policyVersion: policyIdentity(watches),
        lease: {
          leaseId: crypto.randomUUID(),
          task: cursor >= ids.length ? { kind: "search" } : { kind: "item", itemId: ids[cursor] },
        },
      });
    if (url.pathname === "/api/checks/complete") {
      const body = await request.json();
      if (body.discovery) cursor = 0;
      else if (body.offers) {
        details.push(body.offers[0]);
        cursor++;
      } else throw Error("Unexpected error result");
    }
    return Response.json({ ok: true });
  };
  const make = () =>
    new Worker({
      baseUrl: "https://app.test",
      ebayStateUrl: "http://receiver.test:3001",
      watches,
      now: () => now,
      random: () => 0,
      startupDelay: false,
      fetcher,
      ebay: new EbayClient(
        { clientId: "synthetic", clientSecret: "synthetic" },
        fetcher,
        () => now,
      ),
    });
  let worker = make();
  await worker.runOnce();
  expect(browse).toBe(1);
  now = 1;
  await worker.runOnce();
  expect(browse).toBe(1);
  now = budgets.ebay;
  await worker.runOnce();
  expect(browse).toBe(2);
  expect(details).toHaveLength(1);
  worker = make();
  now = budgets.ebay * 2;
  await worker.runOnce();
  expect(browse).toBe(3);
  expect(details).toHaveLength(2);
  expect(mints).toBe(2);
  expect(details.map((o) => (o as { id: string }).id)).toEqual(ids);
});

/** Runs one eBay check against a canned response; returns the check log line and the completion body. */
async function checkOnce(task: unknown, respond: () => Response) {
  const watches = readPolicy(new URL("../fixtures/example-policy.json", import.meta.url).pathname),
    watch = watches[0]!;
  watch.bindings = [
    {
      id: "ebay",
      retailer: "ebay",
      productId: "1234567890123",
      ebayGtin: "1234567890123",
      enabled: true,
      pagePath: "/sch/i.html",
      note: "Synthetic",
    },
  ];
  let completed: Record<string, unknown> = {};
  const fetcher = async (request: Request) => {
    const url = new URL(request.url);
    if (url.hostname === "receiver.test")
      return Response.json({ state: "CLEAR", storageDesignVersion: "tier1-v1", instanceId: "x" });
    if (url.hostname === "api.ebay.com")
      return request.method === "POST"
        ? Response.json({
            access_token: "synthetic",
            expires_in: 7200,
            token_type: "Application Access Token",
          })
        : respond();
    if (url.pathname === "/api/dashboard")
      return Response.json({
        policyVersion: policyIdentity(watches),
        watches: [{ id: watch.id, preferences: { paused: false, muted: false, purchased: false } }],
      });
    if (url.pathname === "/api/checks/claim")
      return Response.json({
        policyVersion: policyIdentity(watches),
        lease: { leaseId: crypto.randomUUID(), task },
      });
    if (url.pathname === "/api/checks/complete") completed = await request.json();
    return Response.json({ ok: true });
  };
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await new Worker({
      baseUrl: "https://app.test",
      ebayStateUrl: "http://receiver.test:3001",
      watches,
      now: () => 1_000_000,
      random: () => 0,
      startupDelay: false,
      fetcher,
      ebay: new EbayClient({ clientId: "synthetic", clientSecret: "synthetic" }, fetcher, () => 0),
    }).runOnce();
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"check"'));
    expect(lines).toHaveLength(1);
    return { line: lines[0]!, completed };
  } finally {
    log.mockRestore();
  }
}
const itemId = "v1|123456789012|0",
  itemTask = { kind: "item", itemId };
const listing = {
  itemId,
  gtin: "1234567890123",
  title: "Synthetic Listing Title",
  conditionId: "1000",
  buyingOptions: ["FIXED_PRICE"],
  price: { value: "499.99", currency: "USD" },
  seller: { username: "SyntheticSellerName", feedbackPercentage: "99.9", feedbackScore: 1000 },
};
const awayWarning = {
  errorId: 11509,
  message: "SyntheticAwayText until 2099-01-01",
  parameters: [{ name: "sellerReturnDate", value: "2099-01-01" }],
};
const forbidden = ["Synthetic", "123456789012", "499.99", "v1|", "api.ebay.com", "sellerReturnDate", "2099"];
test("a seller-away detail completes as an offer with unknown stock and logs nothing from the warning", async () => {
  const { line, completed } = await checkOnce(itemTask, () =>
    Response.json({
      ...listing,
      warnings: [awayWarning],
      estimatedAvailabilities: [
        { estimatedAvailabilityStatus: "IN_STOCK", deliveryOptions: ["SHIP_TO_HOME"] },
      ],
    }),
  );
  expect(JSON.parse(line)).toEqual({ event: "check", retailer: "ebay", outcome: "ok", ms: expect.any(Number) });
  for (const value of ["SyntheticAwayText", "sellerReturnDate", "2099", "SyntheticSellerName"])
    expect(line).not.toContain(value);
  const offers = completed.offers as { availability: string }[];
  expect(offers).toHaveLength(1);
  expect(offers[0]!.availability).toBe("unknown");
  expect(JSON.stringify(completed)).not.toContain("2099");
  expect(JSON.stringify(completed)).not.toContain("SyntheticAwayText");
});
test("eBay invalid-data is logged with a fixed reason and no listing value, and the app never sees it", async () => {
  const warning = { errorId: 11510, message: "Synthetic text" };
  const cases: [() => Response, string][] = [
    [() => Response.json({ ...listing, warnings: [warning] }), "warnings:11510"],
    [
      () => Response.json({ ...listing, warnings: [{ ...awayWarning, errorId: 11509 }, warning] }),
      "warnings:11509,11510",
    ],
    [() => Response.json({ ...listing, gtin: "9876543210123" }), "gtin-mismatch"],
    [() => Response.json({ ...listing, gtin: undefined }), "gtin-missing"],
    [() => Response.json({ ...listing, conditionId: "3000" }), "condition"],
    [() => new Response("not json"), "json"],
    [() => new Response("x".repeat(1024 * 1024 + 1)), "size"],
    [() => Response.json({ ...listing, seller: { feedbackScore: 1.5 } }), "internal"],
  ];
  for (const [respond, reason] of cases) {
    const { line, completed } = await checkOnce(itemTask, respond);
    expect(JSON.parse(line)).toEqual({
      event: "check",
      retailer: "ebay",
      outcome: "invalid-data",
      reason,
      ms: expect.any(Number),
    });
    for (const value of forbidden) expect(line).not.toContain(value);
    expect(completed.error).toBe("invalid-data");
    expect("reason" in completed).toBe(false);
  }
  const search = await checkOnce({ kind: "search" }, () =>
    Response.json({ errors: [{ errorId: 1100, message: "Synthetic" }] }),
  );
  expect(JSON.parse(search.line).reason).toBe("errors");
});
test("a detail with no item gtin but a matching product.gtins list completes as an offer", async () => {
  const { gtin: _omit, ...noGtin } = listing;
  const accepted = await checkOnce(itemTask, () =>
    Response.json({ ...noGtin, product: { gtins: ["1234567890123"] } }),
  );
  expect(JSON.parse(accepted.line)).toEqual({ event: "check", retailer: "ebay", outcome: "ok", ms: expect.any(Number) });
  expect((accepted.completed.offers as unknown[]).length).toBe(1);
  const rejected = await checkOnce(itemTask, () =>
    Response.json({ ...noGtin, product: { gtins: ["9876543210123"] } }),
  );
  expect(JSON.parse(rejected.line).reason).toBe("gtin-mismatch");
});

for (const failure of ["item", "search", "malformed"] as const) {
  test(`eBay ${failure} failure preserves only independently valid canonical evidence`, async () => {
    const watches = readPolicy(
      new URL("../fixtures/example-policy.json", import.meta.url).pathname,
    );
    const watch = watches[0]!;
    watch.bindings = [
      {
        id: "ebay",
        retailer: "ebay",
        productId: "1234567890123",
        ebayGtin: "1234567890123",
        enabled: true,
        pagePath: "/sch/i.html",
        note: "Synthetic",
      },
    ];
    const ids = ["v1|123456789012|0", "v1|123456789013|0"];
    const version = policyIdentity(watches);
    let now = 1_000_000,
      step = 0,
      browse = 0;
    let eventOffer: string | null = null;
    const completions: Record<string, unknown>[] = [];
    const fetcher = async (request: Request) => {
      const url = new URL(request.url);
      if (url.hostname === "receiver.test")
        return Response.json({ state: "CLEAR", storageDesignVersion: "tier1-v1", instanceId: "x" });
      if (url.hostname === "api.ebay.com") {
        if (request.method === "POST")
          return Response.json({
            access_token: "synthetic",
            expires_in: 7200,
            token_type: "Application Access Token",
          });
        browse++;
        if (step >= 2) return new Response(null, { status: 500 });
        return Response.json({
          itemId: ids[step],
          gtin: "1234567890123",
          title: "Synthetic",
          conditionId: "1000",
          buyingOptions: ["FIXED_PRICE"],
          price: { value: "500", currency: "USD" },
          seller: { username: "Synthetic", feedbackPercentage: "99.9", feedbackScore: 1000 },
        });
      }
      if (url.hostname !== "app.test") throw Error("Unexpected external request");
      switch (url.pathname) {
        case "/api/dashboard":
          return Response.json({
            policyVersion: version,
            watches: [
              { id: watch.id, preferences: { paused: false, muted: false, purchased: false } },
            ],
          });
        case "/api/checks/claim":
          return Response.json({
            policyVersion: version,
            lease: {
              leaseId: crypto.randomUUID(),
              task:
                step < 2
                  ? { kind: "item", itemId: ids[step] }
                  : failure === "search"
                    ? { kind: "search" }
                    : { kind: "item", itemId: failure === "item" ? ids[0] : [ids[0]] },
            },
          });
        case "/api/checks/complete":
          step++;
          break;
        case "/api/outbox/claim":
          return Response.json({
            policyVersion: version,
            event:
              eventOffer === null
                ? null
                : {
                    id: crypto.randomUUID(),
                    lease_id: crypto.randomUUID(),
                    watch_id: watch.id,
                    binding_id: "ebay",
                    offer_id: eventOffer,
                    policy_version: version,
                    attempts: 1,
                  },
          });
        case "/api/outbox/complete":
          completions.push(await request.json());
          break;
      }
      return Response.json({ ok: true });
    };
    const worker = new Worker({
      baseUrl: "https://app.test",
      ebayStateUrl: "http://receiver.test:3001",
      watches,
      fetcher,
      now: () => now,
      random: () => 0,
      startupDelay: false,
      webhook: "https://discord.com/api/webhooks/123/testing-placeholder-not-a-real-token",
      ebay: new EbayClient(
        { clientId: "synthetic", clientSecret: "synthetic" },
        fetcher,
        () => now,
      ),
    });
    await worker.runOnce();
    now += budgets.ebay;
    await worker.runOnce();
    const key = `${watch.id}/ebay`;
    const observedB = worker.cache.get(key)!.get(ids[1]!)!.observedAt;
    expect(worker.cache.get(key)?.size).toBe(2);
    now += budgets.ebay;
    eventOffer = ids[1]!;
    await worker.runOnce();
    // Valid B still reaches canonical qualification; unknown fees remain ineligible.
    expect(completions.at(-1)?.result).toBe(
      failure === "malformed" ? "awaiting-revalidation" : "no-longer-eligible",
    );
    expect(worker.cache.get(key)?.has(ids[0]!) ?? false).toBe(failure === "search");
    if (failure !== "malformed")
      expect(worker.cache.get(key)?.get(ids[1]!)?.observedAt).toBe(observedB);
    expect(browse).toBe(failure === "malformed" ? 2 : 3);
    now += 6_000;
    eventOffer = ids[0]!;
    await worker.runOnce();
    expect(completions.at(-1)?.result).toBe("awaiting-revalidation");
    now = observedB + budgets.ebay + 12_001;
    eventOffer = ids[1]!;
    await worker.runOnce();
    expect(completions.at(-1)?.result).toBe("awaiting-revalidation");
    expect(browse).toBe(failure === "malformed" ? 2 : 3);
  });
}
