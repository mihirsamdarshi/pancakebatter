import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { observe, parseBestBuy, parseBrowserUrl, parseTarget } from "./browser-adapters.ts";
import { collect } from "./adapters.ts";
import { readPolicy } from "./policy.ts";
import { Worker } from "./worker.ts";
import type { Fetcher } from "./http.ts";
import { budgets, policyIdentity, qualify, type Binding, type Watch } from "./vendor/domain.ts";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
const watches = readPolicy(new URL("../fixtures/example-policy.json", import.meta.url).pathname);
const base = watches[0]!;
const binding = (retailer: "target" | "bestbuy", zips: string[] | null = [base.zip]): Binding => ({
  id: `${retailer}-console`,
  retailer,
  productId: retailer === "target" ? "93620188" : "6601524",
  pagePath:
    retailer === "target"
      ? "/p/-/A-93620188"
      : "/product/playstation-5-pro-console/JXHQ37TR86/sku/6601524",
  enabled: true,
  note: "test",
  ...(zips ? { shippingPolicyZips: zips } : {}),
});
const watchFor = (...bs: Binding[]): Watch => ({ ...structuredClone(base), id: "ps5", bindings: bs });
const tb = binding("target"),
  bb = binding("bestbuy"),
  w = watchFor(tb, bb);
const BROWSER = "http://browser.test:3000";
const cases = [
  { name: "Target", retailer: "target" as const, b: tb, parse: parseTarget, oos: "target-out-of-stock", ins: "target-in-stock-synthetic", id: "93620188" },
  { name: "Best Buy", retailer: "bestbuy" as const, b: bb, parse: parseBestBuy, oos: "bestbuy-out-of-stock", ins: "bestbuy-in-stock-synthetic", id: "6601524" },
];
const now = Date.now();

for (const c of cases)
  describe(`${c.name} parser`, () => {
    const parse = (o: unknown, b: Binding = c.b) => c.parse(o, watchFor(b), b, now);
    test("real out-of-stock capture", () => {
      const o = parse(fixture(c.oos));
      expect(o.priceCents).toBe(89999);
      expect(o.availability).toBe("out-of-stock");
      expect(o.seller.established).toBe(true);
      expect(o.shipping).toBe("policy-supported");
      expect(o.shippingCents).toBe(0);
      expect(o.feesCents).toBe(0);
      expect(o.zip).toBe(base.zip);
    });
    test("synthetic in-stock at the ceiling is eligible with the policy ZIP", () => {
      const o = parse(fixture(c.ins));
      expect(o.availability).toBe("in-stock");
      expect(base.newCeilingCents).toBe(89999);
      expect(qualify(watchFor(c.b), c.b, o, now).eligible).toBe(true);
    });
    test("price over the ceiling is not eligible", () => {
      const doc = fixture(c.ins);
      const text = JSON.stringify(doc).replaceAll("899.99", "900.99").replaceAll("$899.99", "$900.99");
      const o = parse(JSON.parse(text));
      expect(o.priceCents).toBe(90099);
      expect(qualify(watchFor(c.b), c.b, o, now).eligible).toBe(false);
    });
    test("without the policy ZIP shipping and fees stay unknown and nothing qualifies", () => {
      const b = binding(c.retailer, null);
      const o = parse(fixture(c.ins), b);
      expect(o.shippingCents).toBeNull();
      expect(o.feesCents).toBeNull();
      expect(o.shipping).toBe("unverified");
      expect(qualify(watchFor(b), b, o, now).eligible).toBe(false);
      const other = binding(c.retailer, ["99999"]);
      expect(parse(fixture(c.ins), other).shipping).toBe("unverified");
    });
    test("a cheap item is not assumed to ship free", () => {
      const text = JSON.stringify(fixture(c.oos)).replaceAll("899.99", "30.00").replaceAll("$899.99", "$30.00");
      expect(parse(JSON.parse(text)).shippingCents).toBeNull();
    });
    test("blocked, error and service status map to upstream failures", () => {
      expect(() => parse({ ...fixture(c.oos), blocked: true })).toThrow("access-denied");
      expect(() => parse({ ...fixture(c.oos), status: null, error: "timeout" })).toThrow("network");
      expect(() => parse({ ...fixture(c.oos), status: 429 })).toThrow("throttled");
      expect(() => parse({ ...fixture(c.oos), status: 403 })).toThrow("access-denied");
      expect(() => parse({ ...fixture(c.oos), blocked: undefined })).toThrow("invalid-data");
      expect(() => parse("nope")).toThrow("invalid-data");
    });
    test("wrong product or retailer in the document is invalid", () => {
      expect(() => parse({ ...fixture(c.oos), productId: "1" })).toThrow("invalid-data");
      expect(() => parse({ ...fixture(c.oos), retailer: "sony" })).toThrow("invalid-data");
    });
    test("no body that references the product identity gives invalid-data", () => {
      const doc = fixture(c.oos);
      const text = JSON.stringify(doc).replaceAll(`"${c.id}"`, '"1"').replaceAll(`${c.id},`, "1,");
      expect(() => parse(JSON.parse(text))).toThrow("invalid-data");
      expect(() => parse({ ...doc, responses: [] })).toThrow("invalid-data");
      // Responses from outside the allowlist or with an error status are not evidence.
      const outside = { ...doc, responses: doc.responses.map((r: object) => ({ ...r, path: "/other" })) };
      expect(() => parse(outside)).toThrow("invalid-data");
    });
  });

describe("Target specifics", () => {
  const parse = (o: unknown, b = tb) => parseTarget(o, watchFor(b), b, now);
  const product = (doc: any, key: string) =>
    doc.responses.map((r: any) => r.body.modules[0].module_data.data.product).find((p: any) => key in p);
  test("only a product whose own tcin matches is read (protection plan tcin is ignored)", () => {
    const doc = fixture("target-out-of-stock");
    expect(product(doc, "esp").esp.tcin).not.toBe(tb.productId);
    const bad = fixture("target-out-of-stock");
    product(bad, "esp").tcin = "1";
    expect(() => parse(bad)).toThrow("invalid-data");
  });
  test("conflicting prices or stock statuses are ambiguous", () => {
    const doc = fixture("target-out-of-stock");
    doc.responses.push(structuredClone(doc.responses[1]));
    product(doc, "price").price.formatted_current_price = "$799.99";
    expect(() => parse(doc)).toThrow("invalid-data");
    const stockClash = fixture("target-out-of-stock");
    stockClash.responses.push(fixture("target-in-stock-synthetic").responses[0]);
    expect(() => parse(stockClash)).toThrow("invalid-data");
  });
  test("price label and number must agree and be a plain dollar amount", () => {
    const doc = fixture("target-out-of-stock");
    product(doc, "price").price.current_retail = 799.99;
    expect(() => parse(doc)).toThrow("invalid-data");
    const range = fixture("target-out-of-stock");
    product(range, "price").price.formatted_current_price = "$10.00 - $20.00";
    expect(() => parse(range)).toThrow("invalid-data");
  });
  test("unknown status is unknown; contradicting stock fields never give in-stock", () => {
    const doc = fixture("target-in-stock-synthetic");
    const f = product(doc, "fulfillment").fulfillment;
    f.shipping_options.availability_status = "LIMITED_STOCK";
    expect(parse(doc).availability).toBe("unknown");
    f.shipping_options.availability_status = "IN_STOCK";
    f.sold_out = true;
    expect(parse(doc).availability).toBe("unknown");
    f.sold_out = false;
    f.shipping_options.available_to_promise_quantity = 0;
    expect(parse(doc).availability).toBe("unknown");
  });
  test("a fulfillment for another product id is invalid", () => {
    const doc = fixture("target-in-stock-synthetic");
    product(doc, "fulfillment").fulfillment.product_id = "1";
    expect(() => parse(doc)).toThrow("invalid-data");
  });
  test("marketplace or third-party seller data is rejected by qualify", () => {
    for (const patch of [{ seller: { name: "Someone" } }, { vendor_name: "Partner Co" }, { marketplace: true }]) {
      const doc = fixture("target-in-stock-synthetic");
      Object.assign(product(doc, "price"), patch);
      const o = parse(doc);
      expect(o.seller.established).toBe(false);
      expect(qualify(watchFor(tb), tb, o, now).eligible).toBe(false);
    }
    const nullSeller = fixture("target-in-stock-synthetic");
    Object.assign(product(nullSeller, "price"), { seller: null });
    expect(parse(nullSeller).seller.established).toBe(true);
  });
});

describe("Best Buy specifics", () => {
  const parse = (o: unknown, b = bb) => parseBestBuy(o, watchFor(b), b, now);
  const buttons = (doc: any) =>
    doc.responses.flatMap((r: any) => r.body.data?.fulfillmentOptions?.buttonStates ?? []);
  test("seller proof is classification 1P and marketplaceSeller null", () => {
    const doc = fixture("bestbuy-in-stock-synthetic");
    expect(doc.responses.some((r: any) => r.body.data?.productBySkuId?.seller?.classification === "1P")).toBe(true);
    expect(doc.responses.some((r: any) => r.body.data?.productBySkuId?.seller?.marketplaceSeller === null)).toBe(true);
  });
  test("marketplace seller, other classification or id are rejected by qualify", () => {
    for (const patch of [
      (s: any) => (s.marketplaceSeller = { name: "Third Party" }),
      (s: any) => (s.classification = "3P"),
      (s: any) => (s.id = "other"),
    ]) {
      const doc = fixture("bestbuy-in-stock-synthetic");
      for (const r of doc.responses) if (r.body.data?.productBySkuId?.seller) patch(r.body.data.productBySkuId.seller);
      const o = parse(doc);
      expect(o.seller.established).toBe(false);
      expect(qualify(watchFor(bb), bb, o, now).eligible).toBe(false);
    }
  });
  test("missing seller data is not first-party proof", () => {
    const doc = fixture("bestbuy-in-stock-synthetic");
    doc.responses = doc.responses.filter((r: any) => !r.body.data?.productBySkuId?.seller);
    expect(parse(doc).seller.established).toBe(false);
  });
  test("button states: unknown stays unknown, conflict is invalid, none is invalid", () => {
    const doc = fixture("bestbuy-in-stock-synthetic");
    for (const s of buttons(doc)) s.buttonState = "COMING_SOON";
    expect(parse(doc).availability).toBe("unknown");
    buttons(doc)[0].buttonState = "ADD_TO_CART";
    expect(() => parse(doc)).toThrow("invalid-data");
    const none = fixture("bestbuy-in-stock-synthetic");
    none.responses = none.responses.filter((r: any) => !r.body.data?.fulfillmentOptions);
    expect(() => parse(none)).toThrow("invalid-data");
  });
  test("explicit shipping ineligibility never gives in-stock", () => {
    const doc = fixture("bestbuy-in-stock-synthetic");
    for (const r of doc.responses)
      for (const d of r.body.data?.fulfillmentOptions?.shippingDetails ?? [])
        for (const a of d.shippingAvailability) a.shippingEligible = false;
    expect(parse(doc).availability).toBe("unknown");
  });
  test("other SKUs and recommendation prices are never read", () => {
    const doc = fixture("bestbuy-out-of-stock");
    doc.responses.push({
      path: "/gateway/graphql",
      status: 200,
      body: { data: { productBySkuId: { skuId: "1111111", price: { customerPrice: 1.0 } } } },
    });
    doc.responses.push({
      path: "/gateway/graphql",
      status: 200,
      body: { data: { productBySkuId: { price: { customerPrice: 2.0 } } } },
    });
    expect(parse(doc).priceCents).toBe(89999);
    const conflict = fixture("bestbuy-out-of-stock");
    conflict.responses.push({
      path: "/gateway/graphql",
      status: 200,
      body: { data: { productBySkuId: { skuId: bb.productId, price: { customerPrice: 799.99 } } } },
    });
    expect(() => parse(conflict)).toThrow("invalid-data");
  });
  test("title comes from the product name when present", () => {
    expect(parse(fixture("bestbuy-out-of-stock")).title).toBe("PlayStation 5 Pro Console");
    expect(fixture("bestbuy-out-of-stock").responses.some((r: any) => r.body.data?.productBySkuId?.seller?.id === "bby")).toBe(true);
  });
});

describe("BROWSER_URL", () => {
  test("accepts http or https origins only", () => {
    expect(parseBrowserUrl("http://browser.svc.cluster.local:3000")).toBe("http://browser.svc.cluster.local:3000");
    expect(parseBrowserUrl("https://browser.test/")).toBe("https://browser.test");
    for (const bad of [
      "ftp://x.test",
      "http://u:p@x.test",
      "http://x.test/?a=1",
      "http://x.test?",
      "http://x.test/#f",
      "http://x.test/path",
      "nope",
      "",
    ])
      expect(() => parseBrowserUrl(bad)).toThrow();
  });
  test("worker rejects a bad value at construction", () => {
    expect(
      () => new Worker({ baseUrl: "https://app.test", watches, browserUrl: "http://u:p@x.test" }),
    ).toThrow();
  });
});

describe("observe client", () => {
  const ok = (body: unknown = { ok: 1 }) => new Response(JSON.stringify(body));
  test("posts only retailer and productId to /observe", async () => {
    let request: Request | undefined;
    const fetcher: Fetcher = async (r) => ((request = r), ok());
    await observe(`${BROWSER}/`, "target", "93620188", tb.pagePath, fetcher);
    expect(request!.method).toBe("POST");
    expect(request!.url).toBe(`${BROWSER}/observe`);
    expect(await request!.json()).toEqual({ retailer: "target", productId: "93620188", path: tb.pagePath });
    expect(request!.redirect).toBe("error");
  });
  test("rejects bad product ids before any request", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => (calls++, ok());
    await expect(observe(BROWSER, "target", "../x", "/p/-/A-1", fetcher)).rejects.toThrow("invalid-data");
    expect(calls).toBe(0);
  });
  test("page paths must match the retailer pattern for the product", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => (calls++, ok());
    const bad: [any, string, string][] = [
      ["target", "93620188", "/p/-/A-1"],
      ["target", "93620188", "https://x.test/p/-/A-93620188"],
      ["target", "93620188", "/p/-/A-93620188?x=1"],
      ["bestbuy", "6601524", "/site/6601524.p"],
      ["bestbuy", "6601524", "/product/x/JXHQ37TR86/sku/1"],
      ["bestbuy", "6601524", "/product/x/jxhq37tr86/sku/6601524"],
      ["bestbuy", "6601524", "/product/X/JXHQ37TR86/sku/6601524"],
      ["bestbuy", "6601524", "/product/x/JXHQ37TR86/sku/6601524/"],
    ];
    for (const [r, id, path] of bad)
      await expect(observe(BROWSER, r, id, path, fetcher)).rejects.toMatchObject({ code: "invalid-data" });
    expect(calls).toBe(0);
    await observe(BROWSER, "bestbuy", "6601524", bb.pagePath, fetcher);
    expect(calls).toBe(1);
  });
  test("timeout aborts the request and maps to network", async () => {
    const fetcher: Fetcher = (r) =>
      new Promise((_, reject) => r.signal.addEventListener("abort", () => reject(r.signal.reason)));
    await expect(observe(BROWSER, "target", "1", "/p/-/A-1", fetcher, 20)).rejects.toMatchObject({ code: "network" });
  });
  test("429 is throttled with Retry-After, busy 400/5xx map to failures", async () => {
    await expect(
      observe(BROWSER, "target", "1", "/p/-/A-1", async () => new Response("busy", { status: 429, headers: { "retry-after": "30" } })),
    ).rejects.toMatchObject({ code: "throttled", retryAfterMs: 30000 });
    await expect(observe(BROWSER, "target", "1", "/p/-/A-1", async () => new Response("", { status: 400 }))).rejects.toMatchObject({ code: "invalid-data" });
    await expect(observe(BROWSER, "target", "1", "/p/-/A-1", async () => new Response("", { status: 500 }))).rejects.toMatchObject({ code: "network" });
    await expect(observe(BROWSER, "target", "1", "/p/-/A-1", async () => { throw new Error("connect refused"); })).rejects.toMatchObject({ code: "network" });
  });
  test("bad JSON and oversize bodies are invalid", async () => {
    await expect(observe(BROWSER, "target", "1", "/p/-/A-1", async () => new Response("<html>"))).rejects.toMatchObject({ code: "invalid-data" });
    const big = new Response(new Uint8Array(14 * 1024 * 1024));
    await expect(observe(BROWSER, "target", "1", "/p/-/A-1", async () => big)).rejects.toMatchObject({ code: "invalid-data" });
    const declared = new Response("{}", { headers: { "content-length": String(14 * 1024 * 1024) } });
    await expect(observe(BROWSER, "target", "1", "/p/-/A-1", async () => declared)).rejects.toMatchObject({ code: "invalid-data" });
  });
});

describe("collect routing", () => {
  const served = (retailer: "target" | "bestbuy") =>
    fixture(retailer === "target" ? "target-in-stock-synthetic" : "bestbuy-in-stock-synthetic");
  test("without BROWSER_URL these retailers are unsupported and make no request", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => (calls++, ok());
    for (const b of [tb, bb])
      await expect(collect(watchFor(b), b, fetcher, now)).rejects.toMatchObject({ code: "unsupported" });
    expect(calls).toBe(0);
  });
  test("a bad pagePath fails before any request", async () => {
    let calls = 0;
    const bad = { ...bb, pagePath: "/site/6601524.p" };
    await expect(
      collect(watchFor(bad), bad, async () => (calls++, ok()), now, new Map(), BROWSER),
    ).rejects.toMatchObject({ code: "invalid-data" });
    expect(calls).toBe(0);
  });
  test("with BROWSER_URL the matching parser runs", async () => {
    for (const b of [tb, bb]) {
      const o = await collect(
        watchFor(b), b, async () => Response.json(served(b.retailer as "target" | "bestbuy")), now, new Map(), BROWSER,
      );
      expect(o.availability).toBe("in-stock");
      expect(o.priceCents).toBe(89999);
    }
  });
});
function ok(body: unknown = { ok: 1 }) {
  return new Response(JSON.stringify(body));
}

describe("worker with a mocked browser", () => {
  function harness(config: Watch[], doc: (retailer: string) => unknown, random = () => 0) {
    let clock = now;
    const browser: string[] = [],
      complete: any[] = [];
    const fetcher: Fetcher = async (request) => {
      const url = new URL(request.url);
      if (url.hostname === "browser.test") {
        const body = await request.json();
        expect(url.pathname).toBe("/observe");
        browser.push(body.retailer);
        return Response.json(doc(body.retailer));
      }
      if (url.hostname !== "app.test") throw new Error("Unexpected host");
      if (url.pathname === "/api/integrations/status") return Response.json({ ok: true });
      const identity = { policyVersion: policyIdentity(config), policyIdentity };
      if (url.pathname === "/api/dashboard")
        return Response.json({
          ...identity,
          watches: config.map((c) => ({ id: c.id, preferences: { paused: false, muted: false, purchased: false } })),
        });
      if (url.pathname === "/api/checks/claim")
        return Response.json({ ...identity, lease: { leaseId: crypto.randomUUID() } });
      if (url.pathname === "/api/checks/complete") {
        complete.push(await request.json());
        return Response.json({ ok: true });
      }
      throw new Error("Unexpected API path");
    };
    const worker = new Worker({
      baseUrl: "https://app.test",
      watches: config,
      fetcher,
      browserUrl: BROWSER,
      now: () => clock,
      random,
      startupDelay: false,
    });
    return { worker, browser, complete, now: () => clock, advance: (ms: number) => (clock += ms) };
  }
  const docFor = (retailer: string) =>
    fixture(retailer === "target" ? "target-in-stock-synthetic" : "bestbuy-in-stock-synthetic");
  test("posts the expected offers and respects each retailer floor", async () => {
    const h = harness([w], docFor);
    await h.worker.runOnce();
    expect(h.browser.sort()).toEqual(["bestbuy", "target"]);
    const offers = h.complete.map((c) => c.offer);
    expect(offers.map((o) => o.priceCents)).toEqual([89999, 89999]);
    expect(offers.every((o) => o.availability === "in-stock" && o.shipping === "policy-supported")).toBe(true);
    await h.worker.runOnce();
    expect(h.browser.length).toBe(2);
    h.advance(900_000);
    await h.worker.runOnce();
    expect(h.browser.length).toBe(2);
    h.advance(budgets.target - 900_000 - 1);
    await h.worker.runOnce();
    expect(h.browser.length).toBe(2);
    h.advance(1);
    await h.worker.runOnce();
    expect(h.browser.sort()).toEqual(["bestbuy", "target", "target"]);
    h.advance(budgets.bestbuy - budgets.target);
    await h.worker.runOnce();
    expect(h.browser.filter((r) => r === "bestbuy").length).toBe(2);
  });
  test("Target is budgeted at 30 minutes and Best Buy at 2 hours, with jitter on top", async () => {
    expect(budgets.target).toBe(1_800_000);
    expect(budgets.bestbuy).toBe(7_200_000);
    const h = harness([watchFor(bb)], docFor, () => 0.99);
    await h.worker.runOnce();
    expect(h.worker.floor.get("bestbuy")).toBe(h.now() + 7_200_000 + Math.floor(0.99 * 720_000));
  });
  test("a blocked page is reported as access-denied and backs the retailer off", async () => {
    const h = harness([watchFor(tb)], () => ({ ...fixture("target-out-of-stock"), blocked: true }));
    await h.worker.runOnce();
    expect(h.complete[0]).toMatchObject({ error: "access-denied" });
    expect(h.complete[0].retryAfterMs).toBeGreaterThanOrEqual(budgets.target * 2);
  });
});
