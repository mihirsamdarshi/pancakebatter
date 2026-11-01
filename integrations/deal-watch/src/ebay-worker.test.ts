import { expect, test } from "bun:test";
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
