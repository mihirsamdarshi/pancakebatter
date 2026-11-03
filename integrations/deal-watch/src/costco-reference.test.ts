import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseCostco, parseReferences, fetchReferences, EXTRA_REFERENCE_CODES } from "./adapters.ts";
import { Worker } from "./worker.ts";
import { readPolicy } from "./policy.ts";
import { policyIdentity, qualify, budgets, type Watch } from "./vendor/domain.ts";
import type { Fetcher } from "./http.ts";

const base = readPolicy(new URL("../fixtures/example-policy.json", import.meta.url).pathname);
const html = readFileSync(
  new URL("../fixtures/costco-out-of-stock.html", import.meta.url),
  "utf8",
).replace("/OutOfStock", "/InStock");
const policy = (zip = true, enabled = true): Watch[] => {
  const ws = structuredClone(base);
  for (const b of ws[0]!.bindings) {
    if (b.id === "costco-bundle") {
      b.enabled = enabled;
      if (zip) b.shippingPolicyZips = ["10001"];
    }
    if (b.id === "sony-console") b.enabled = true;
  }
  return ws;
};
const NOW = 1_800_000_000_000;
const costcoOf = (ws: Watch[]) => ws[0]!.bindings.find((b) => b.id === "costco-bundle")!;
const ref = (cents: number, at: number) => new Map([["dualsense-grey-camo", { cents, at }]]);
const sonyBody = (items: Record<string, unknown>[]) => JSON.stringify({ products: items });
const item = (code: string, value: number | string, extra: Record<string, unknown> = {}) => ({
  code,
  validProductCode: true,
  price: { value, currencyIso: "USD" },
  ...extra,
});

describe("Costco eligibility", () => {
  test("policy ZIP and fresh reference: eligible at 94999", async () => {
    const ws = policy(),
      b = costcoOf(ws),
      o = await parseCostco(html, ws[0]!, b, NOW, ref(7499, NOW - 1000));
    expect(o.shipping).toBe("policy-supported");
    expect(o.shippingCents).toBe(0);
    expect(o.feesCents).toBe(0);
    const q = qualify(ws[0]!, b, o, NOW);
    expect(q.eligible).toBe(true);
    expect(q.totalCents).toBe(94999);
  });
  test("ZIP missing from policy: ineligible, shipping unknown", async () => {
    const ws = policy(false),
      b = costcoOf(ws),
      o = await parseCostco(html, ws[0]!, b, NOW, ref(7499, NOW));
    expect(o.shippingCents).toBeNull();
    const q = qualify(ws[0]!, b, o, NOW);
    expect(q.eligible).toBe(false);
    expect(q.reasons).toContain("Shipping or mandatory fees unknown");
  });
  test("no reference or reference older than 24 hours: missing or stale", async () => {
    const ws = policy(),
      b = costcoOf(ws);
    for (const refs of [undefined, ref(7499, NOW - 86_400_001)]) {
      const o = await parseCostco(html, ws[0]!, b, NOW, refs);
      expect(o.extras[0]?.referenceCents).toBeNull();
      const q = qualify(ws[0]!, b, o, NOW);
      expect(q.eligible).toBe(false);
      expect(q.reasons).toContain("Bundle reference price missing or stale");
    }
  });
});

describe("reference parsing", () => {
  const ids = ["dualsense-grey-camo"];
  test("gray valid gives gray price", () => {
    const body = sonyBody([item("1000050328", 74), item("1000050331", "69.99")]);
    expect(parseReferences(body, ids).get(ids[0]!)).toBe(6999);
  });
  test("gray invalid or absent gives white price", () => {
    const invalid = sonyBody([item("1000050328", 74), item("1000050331", 69, { validProductCode: false })]);
    expect(parseReferences(invalid, ids).get(ids[0]!)).toBe(7400);
    expect(parseReferences(sonyBody([item("1000050328", 74)]), ids).get(ids[0]!)).toBe(7400);
  });
  test("neither valid, bad currency or bad price: no entry", () => {
    expect(parseReferences(sonyBody([]), ids).size).toBe(0);
    const bad = sonyBody([
      item("1000050331", 0),
      { ...item("1000050328", 74), price: { value: 74, currencyIso: "CAD" } },
    ]);
    expect(parseReferences(bad, ids).size).toBe(0);
  });
  test("malformed body: no entry, no throw", () => {
    for (const body of ["not json", "[]", '{"products":3}', "null", ""])
      expect(parseReferences(body, ids).size).toBe(0);
  });
  test("request is one productList call with all mapped codes; unmapped IDs make none", async () => {
    const urls: string[] = [];
    const f: Fetcher = async (r) => {
      urls.push(r.url);
      return new Response(sonyBody([item("1000050328", 74)]));
    };
    expect((await fetchReferences(["unknown"], f)).size).toBe(0);
    expect(urls.length).toBe(0);
    expect((await fetchReferences(ids, f)).get(ids[0]!)).toBe(7400);
    expect(urls).toEqual([
      "https://api.direct.playstation.com/commercewebservices/ps-direct-us/products/productList?fields=BASIC&productCodes=1000050331,1000050328",
    ]);
    expect(EXTRA_REFERENCE_CODES[ids[0]!]).toEqual(["1000050331", "1000050328"]);
  });
});

function rig(ws: Watch[], refStatus = 200) {
  const ctl = { sonyStatus: 200, refAbort: false };
  let clock = NOW;
  const sony: string[] = [],
    complete: Record<string, unknown>[] = [];
  const snapshot = JSON.parse(readFileSync(new URL("../fixtures/sony-out-of-stock.json", import.meta.url), "utf8"));
  const fetcher: Fetcher = async (req) => {
    const url = new URL(req.url);
    if (url.hostname === "api.direct.playstation.com") {
      const codes = url.searchParams.get("productCodes")!;
      sony.push(codes);
      if (codes.includes(",")) {
        if (ctl.refAbort) throw new DOMException("timed out", "AbortError");
        if (refStatus !== 200) return new Response("", { status: refStatus });
        return new Response(sonyBody([item("1000050328", 74)]));
      }
      if (ctl.sonyStatus !== 200) return new Response("", { status: ctl.sonyStatus });
      return Response.json(snapshot);
    }
    if (url.hostname === "www.costco.com") return new Response(html);
    if (url.hostname !== "app.test") throw new Error("Unexpected host");
    const id = policyIdentity(ws);
    if (url.pathname === "/api/dashboard")
      return Response.json({
        policyVersion: id,
        watches: ws.map((w) => ({ id: w.id, preferences: { paused: false, muted: false, purchased: false } })),
      });
    if (url.pathname === "/api/integrations/status") return Response.json({ ok: true });
    if (url.pathname === "/api/checks/claim") {
      return Response.json({ policyVersion: id, lease: { leaseId: crypto.randomUUID() } });
    }
    if (url.pathname === "/api/checks/complete") {
      complete.push(await req.json());
      return Response.json({ ok: true });
    }
    throw new Error("Unexpected API path");
  };
  const worker = new Worker({
    baseUrl: "https://app.test",
    watches: ws,
    fetcher,
    now: () => clock,
    random: () => 0,
    startupDelay: false,
  });
  return { ctl, worker, sony, complete, advance: (ms: number) => (clock += ms) };
}
const refCalls = (r: { sony: string[] }) => r.sony.filter((c) => c.includes(",")).length;

describe("worker reference refresh", () => {
  test("one request after first Sony check, none within 6h, one after 6h", async () => {
    const ws = policy(true, false),
      r = rig(ws);
    await r.worker.runOnce();
    expect(r.sony.filter((c) => !c.includes(","))).toEqual(["1000050805"]);
    expect(refCalls(r)).toBe(0); // costco binding disabled: no mapped enabled extras
    const ws2 = policy(true, true),
      r2 = rig(ws2);
    await r2.worker.runOnce();
    expect(refCalls(r2)).toBe(1);
    r2.advance(budgets.sony);
    await r2.worker.runOnce();
    expect(r2.sony.filter((c) => !c.includes(",")).length).toBe(2);
    expect(refCalls(r2)).toBe(1);
    r2.advance(21_600_000);
    await r2.worker.runOnce();
    expect(refCalls(r2)).toBe(2);
  });
  test("failed attempt retries after 30 minutes; ok attempt waits 6 hours", async () => {
    const at = async (status: number, ms: number) => {
      const r = rig(policy(), status);
      await r.worker.runOnce();
      r.advance(ms);
      await r.worker.runOnce();
      return refCalls(r);
    };
    expect(await at(500, 29 * 60_000)).toBe(1);
    expect(await at(500, 30 * 60_000)).toBe(2);
    expect(await at(200, 5 * 3_600_000 + 59 * 60_000)).toBe(1);
    expect(await at(200, 6 * 3_600_000)).toBe(2);
  });
  test("failing reference request leaves Sony observation, floor and failure count unchanged", async () => {
    const ws = policy(),
      ok = rig(ws),
      bad = rig(ws, 500);
    await ok.worker.runOnce();
    await bad.worker.runOnce();
    expect(refCalls(bad)).toBe(1);
    const sonyOnly = (r: { complete: Record<string, unknown>[] }) =>
      r.complete.filter((c) => c.bindingId === "sony-console").map((c) => ({ ...c, leaseId: "x" }));
    expect(sonyOnly(bad)).toEqual(sonyOnly(ok));
    expect(sonyOnly(bad).length).toBe(1);
    expect(bad.worker.failures.get("sony")).toBe(ok.worker.failures.get("sony"));
    expect(bad.worker.floor.get("sony")).toBe(ok.worker.floor.get("sony"));
    expect(bad.worker.references.size).toBe(0);
    expect(bad.worker.cache.get("example-console/sony-console")?.size).toBe(1);
  });
  test("reference request that times out changes nothing about the Sony check", async () => {
    const ws = policy(),
      ok = rig(ws),
      slow = rig(ws);
    slow.ctl.refAbort = true;
    await ok.worker.runOnce();
    await slow.worker.runOnce();
    expect(refCalls(slow)).toBe(1);
    const sonyOnly = (r: { complete: Record<string, unknown>[] }) =>
      r.complete.filter((c) => c.bindingId === "sony-console").map((c) => ({ ...c, leaseId: "x" }));
    expect(sonyOnly(slow)).toEqual(sonyOnly(ok));
    expect(slow.worker.failures.get("sony")).toBe(ok.worker.failures.get("sony"));
    expect(slow.worker.floor.get("sony")).toBe(ok.worker.floor.get("sony"));
    expect(slow.worker.references.size).toBe(0);
  });
  test("a failed Sony check makes no reference request; the next successful one does", async () => {
    const r = rig(policy());
    r.ctl.sonyStatus = 429;
    await r.worker.runOnce();
    expect(r.sony).toEqual(["1000050805"]);
    expect(r.complete.find((c) => c.bindingId === "sony-console")?.error).toBe("throttled");
    r.ctl.sonyStatus = 200;
    r.advance(budgets.sony * 64);
    await r.worker.runOnce();
    expect(refCalls(r)).toBe(1);
  });
  test("a Costco check after a successful reference posts an offer carrying it", async () => {
    const ws = policy(),
      r = rig(ws);
    await r.worker.runOnce(); // sony check + reference
    expect(r.worker.references.get("dualsense-grey-camo")?.cents).toBe(7400);
    r.advance(budgets.costco);
    await r.worker.runOnce();
    const offer = (r.complete.at(-1) as { offer: { extras: { referenceCents: number | null; referenceAt: number | null }[] } }).offer;
    expect(offer.extras[0]?.referenceCents).toBe(7400);
    expect(offer.extras[0]?.referenceAt).toBe(NOW);
  });
});
