import { describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSony, parseCostco, collect } from "./adapters.ts";
import { boundedText, getPublic, retryAfter, type Fetcher } from "./http.ts";
import { readWebhook, sendDiscord, message } from "./discord.ts";
import { Worker } from "./worker.ts";
import { readPolicy } from "./policy.ts";
import { budgets } from "./vendor/domain.ts";
const watches = readPolicy(new URL("../fixtures/example-policy.json", import.meta.url).pathname);
import { POLICY_VERSION, policyIdentity, qualify, type Watch } from "./vendor/domain.ts";
const w = watches[0]!,
  b = w.bindings[0]!,
  fixture = readFileSync(new URL("../fixtures/sony-out-of-stock.json", import.meta.url), "utf8"),
  costco = readFileSync(new URL("../fixtures/costco-out-of-stock.html", import.meta.url), "utf8");
const stock = (productId = b.productId) => {
  const data = JSON.parse(fixture);
  data.products[0].code = productId;
  data.products[0].stock.stockLevelStatus = "inStock";
  return JSON.stringify(data);
};
const webhook = "https://discord.com/api/webhooks/123/testing-placeholder-not-a-real-token";

describe("captured source metadata", () => {
  test("Sony OOS overrides purchasable/order-limit fields", () => {
    const data = JSON.parse(fixture);
    data.products[0].purchasable = true;
    data.products[0].maxOrderQuantity = 99;
    expect(parseSony(JSON.stringify(data), w, b).availability).toBe("out-of-stock");
    expect(parseSony(fixture, w, b).priceCents).toBe(89900);
  });
  test("Sony exact identity, currency and full payload required", () => {
    for (const patch of [
      { code: "999" },
      { validProductCode: false },
      { price: { value: 899, currencyIso: "CAD" } },
      { price: { value: 0, currencyIso: "USD" } },
      { stock: {} },
    ]) {
      const data = JSON.parse(fixture);
      Object.assign(data.products[0], patch);
      expect(() => parseSony(JSON.stringify(data), w, b)).toThrow();
    }
    expect(() => parseSony("<html>Robot or human?</html>", w, b)).toThrow();
  });
  test("Sony gated or preorder product never becomes ordinary stock", () => {
    for (const patch of [
      { loginGated: true },
      { psPlusGated: true },
      { preOrderProduct: true },
      { purchasable: false },
    ]) {
      const data = JSON.parse(stock());
      Object.assign(data.products[0], patch);
      expect(parseSony(JSON.stringify(data), w, b).availability).toBe("unknown");
    }
  });
  test("Costco snapshot gives price/stock without inventing shipping or bundle values", async () => {
    const binding = w.bindings.find((b) => b.retailer === "costco")!,
      o = await parseCostco(costco, w, binding);
    expect(o.priceCents).toBe(94999);
    expect(o.availability).toBe("out-of-stock");
    expect(o.shippingCents).toBeNull();
    expect(o.feesCents).toBeNull();
    expect(o.extras[0]?.referenceCents).toBeNull();
    expect(qualify(w, binding, o).eligible).toBe(false);
  });
  test("Costco ambiguity or wrong SKU is not a valid price", async () => {
    const binding = w.bindings.find((b) => b.retailer === "costco")!;
    await expect(parseCostco(costco.replace("1793150", "111"), w, binding)).rejects.toThrow();
    await expect(parseCostco("<title>Robot or human?</title>", w, binding)).rejects.toThrow();
  });
});
describe("bounded transport", () => {
  test("200 challenge, access refusal, throttle and response-size errors remain failures", async () => {
    await expect(
      collect(w, b, async () => new Response("<title>Robot or human?</title>")),
    ).rejects.toThrow();
    await expect(
      getPublic(
        "https://api.direct.playstation.com/test",
        async () => new Response("", { status: 403 }),
      ),
    ).rejects.toThrow("access-denied");
    await expect(
      getPublic(
        "https://api.direct.playstation.com/test",
        async () => new Response("", { status: 429, headers: { "retry-after": "120" } }),
      ),
    ).rejects.toMatchObject({ code: "throttled", retryAfterMs: 120000 });
    await expect(boundedText(new Response("abc"), 2)).rejects.toThrow();
    await expect(getPublic("https://127.0.0.1/test")).rejects.toThrow("unsupported");
  });
  test("Retry-After supports seconds and HTTP dates", () => {
    expect(retryAfter("2", 1000)).toBe(2000);
    expect(retryAfter(new Date(10000).toUTCString(), 1000)).toBe(9000);
    expect(retryAfter("bad")).toBe(0);
  });
});
describe("Discord", () => {
  test("fixed URL, wait=true, no mentions, acknowledgement required", async () => {
    let request: Request | undefined;
    const fetcher: Fetcher = async (r) => {
      request = r;
      return Response.json({ id: "123456" });
    };
    const o = parseSony(stock(), w, b);
    const content = message(w, b, o, crypto.randomUUID());
    expect(content).toContain("ZIP checkout unverified");
    const result = await sendDiscord(webhook, content, fetcher);
    expect(result.status).toBe("sent");
    expect(new URL(request!.url).searchParams.get("wait")).toBe("true");
    expect((await request!.json()).allowed_mentions).toEqual({ parse: [] });
    expect(
      (await sendDiscord(webhook, content, async () => new Response(null, { status: 204 }))).result,
    ).toBe("uncertain");
  });
  test("429 body/header cooldown respected and network timeout is uncertain", async () => {
    expect(
      (
        await sendDiscord(webhook, "test", async () =>
          Response.json({ retry_after: 120 }, { status: 429, headers: { "retry-after": "60" } }),
        )
      ).delayMs,
    ).toBe(120000);
    expect(
      (
        await sendDiscord(webhook, "test", async () => {
          throw new Error("sensitive URL must not escape");
        })
      ).result,
    ).toBe("uncertain");
  });
  test("credential validation errors never echo file contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "deal-watch-webhook-"));
    try {
      const file = join(dir, "credential");
      writeFileSync(file, "do-not-print-this-value");
      expect(() => readWebhook(file)).toThrow("Invalid Discord credential file");
      writeFileSync(file, webhook);
      expect(readWebhook(file)).toBe(webhook);
      writeFileSync(file, webhook + "?redirect=bad");
      expect(() => readWebhook(file)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function harness(config: Watch[] = watches, deliver = false) {
  let clock = Date.now(),
    publicCalls = 0,
    discordCalls = 0,
    failComplete = false;
  const statusReports: Record<string, unknown>[] = [];
  const complete: Record<string, unknown>[] = [],
    productIds: string[] = [];
  const event = {
    id: crypto.randomUUID(),
    lease_id: crypto.randomUUID(),
    watch_id: w.id,
    binding_id: b.id,
    offer_id: b.productId,
    policy_version: policyIdentity(config),
    policyIdentity,
    attempts: 1,
    message: "untrusted app message",
    url: "https://evil.example",
  };
  const fetcher: Fetcher = async (request) => {
    const url = new URL(request.url);
    if (url.hostname === "api.direct.playstation.com") {
      publicCalls++;
      const id = url.searchParams.get("productCodes")!;
      productIds.push(id);
      return new Response(stock(id));
    }
    if (url.hostname === "discord.com") {
      discordCalls++;
      const payload = await request.json();
      expect(payload.content).not.toContain("untrusted app message");
      expect(payload.content).not.toContain("evil.example");
      return Response.json({ id: "12345" });
    }
    if (url.hostname !== "app.test") throw new Error("Unexpected host");
    if (url.pathname === "/api/integrations/status") {
      statusReports.push(await request.json());
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/dashboard")
      return Response.json({
        policyVersion: policyIdentity(config),
        policyIdentity,
        watches: config.map((w) => ({
          id: w.id,
          preferences: { paused: false, muted: false, purchased: false },
        })),
      });
    if (url.pathname === "/api/checks/claim")
      return Response.json({
        policyVersion: policyIdentity(config),
        policyIdentity,
        lease: { leaseId: crypto.randomUUID() },
      });
    if (url.pathname === "/api/checks/complete") {
      if (failComplete) throw new Error("App unavailable");
      complete.push(await request.json());
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/outbox/claim")
      return Response.json({
        policyVersion: policyIdentity(config),
        policyIdentity,
        event: deliver ? event : null,
      });
    if (url.pathname === "/api/outbox/complete") {
      complete.push(await request.json());
      return Response.json({ ok: true });
    }
    throw new Error("Unexpected API path");
  };
  return {
    fetcher,
    statusReports,
    event,
    complete,
    productIds,
    get now() {
      return clock;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    get publicCalls() {
      return publicCalls;
    },
    get discordCalls() {
      return discordCalls;
    },
    set failComplete(v: boolean) {
      failComplete = v;
    },
  };
}
describe("worker independent safeguards", () => {
  test("an app willing to grant every claim cannot exceed retailer floor", async () => {
    const h = harness(),
      worker = new Worker({
        baseUrl: "https://app.test",
        watches,
        fetcher: h.fetcher,
        now: () => h.now,
        random: () => 0,
        startupDelay: false,
      });
    await worker.runOnce();
    await worker.runOnce();
    expect(h.publicCalls).toBe(1);
    h.advance(budgets.sony);
    await worker.runOnce();
    expect(h.publicCalls).toBe(2);
  });
  test("startup restart cannot erase the worker minimum", async () => {
    const h = harness(),
      worker = new Worker({
        baseUrl: "https://app.test",
        watches,
        fetcher: h.fetcher,
        now: () => h.now,
        random: () => 0,
      });
    await worker.runOnce();
    expect(h.publicCalls).toBe(0);
    h.advance(budgets.sony);
    await worker.runOnce();
    expect(h.publicCalls).toBe(1);
  });
  test("second product uses same code and gets a fair turn in the shared budget", async () => {
    const second: Watch = {
      ...structuredClone(w),
      id: "second",
      bindings: [
        { ...b, id: "second-sony", productId: "123", pagePath: "/en-us/buy-accessories/second" },
      ],
    };
    const h = harness([w, second]),
      worker = new Worker({
        baseUrl: "https://app.test",
        watches: [w, second],
        fetcher: h.fetcher,
        now: () => h.now,
        random: () => 0,
        startupDelay: false,
      });
    await worker.runOnce();
    h.advance(budgets.sony);
    await worker.runOnce();
    expect(h.productIds).toEqual([b.productId, "123"]);
  });
  test("message comes from worker-fetched canonical evidence and duplicate app events are suppressed", async () => {
    const h = harness(watches, true),
      worker = new Worker({
        baseUrl: "https://app.test",
        watches,
        webhook,
        fetcher: h.fetcher,
        now: () => h.now,
        random: () => 0,
        startupDelay: false,
      });
    await worker.runOnce();
    expect(h.discordCalls).toBe(1);
    h.advance(6000);
    h.event.id = crypto.randomUUID();
    await worker.runOnce();
    expect(h.discordCalls).toBe(1);
    expect(h.complete.at(-1)?.result).toBe("duplicate-current-offer");
  });
  test("outbox after restart awaits revalidation instead of using app evidence", async () => {
    const h = harness(watches, true),
      worker = new Worker({
        baseUrl: "https://app.test",
        watches,
        webhook,
        fetcher: h.fetcher,
        now: () => h.now,
      });
    await worker.runOnce();
    expect(h.publicCalls).toBe(0);
    expect(h.discordCalls).toBe(0);
    expect(h.complete.at(-1)?.result).toBe("awaiting-revalidation");
  });
  test("failed scheduling persistence stops further work and delivery", async () => {
    const h = harness(watches, true);
    h.failComplete = true;
    const worker = new Worker({
      baseUrl: "https://app.test",
      watches,
      webhook,
      fetcher: h.fetcher,
      now: () => h.now,
      startupDelay: false,
    });
    await expect(worker.runOnce()).rejects.toThrow();
    expect(h.discordCalls).toBe(0);
  });
  test("only fixed HTTPS app origins accepted outside explicit local tests", () => {
    expect(() => new Worker({ baseUrl: "http://app.test", watches })).toThrow();
    expect(() => new Worker({ baseUrl: "https://user:password@app.test", watches })).toThrow();
    expect(() => new Worker({ baseUrl: "https://app.test/other", watches })).toThrow();
    expect(
      () => new Worker({ baseUrl: "http://localhost:3000", watches, allowLocalHttp: true }),
    ).not.toThrow();
  });
});

test("Costco rejects array-coerced product identities", async () => {
  const binding = w.bindings.find((b) => b.retailer === "costco")!;
  const malformed = costco.replace('"sku": "1793150"', '"sku": ["1793150"]');
  expect(malformed).not.toBe(costco);
  await expect(parseCostco(malformed, w, binding)).rejects.toThrow();
});

test("a stale approved worker policy is reported and blocks collection and delivery", async () => {
  const other = [{ ...structuredClone(w), newCeilingCents: 89900 }];
  const h = harness(other, true),
    worker = new Worker({
      baseUrl: "https://app.test",
      watches,
      webhook,
      fetcher: h.fetcher,
      now: () => h.now,
      startupDelay: false,
    });
  await expect(worker.runOnce()).rejects.toThrow("Policy mismatch");
  expect(h.publicCalls).toBe(0);
  expect(h.discordCalls).toBe(0);
  expect(h.statusReports[0]?.state).toBe("policy-mismatch");
});
