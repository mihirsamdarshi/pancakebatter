import { expect, test } from "bun:test";
import { Worker } from "./worker.ts";
import { EbayClient } from "./ebay.ts";
import { readPolicy } from "./policy.ts";
import { parseEbay } from "./ebay-adapter.ts";
import { message } from "./discord.ts";
import { auditEbayOffers, readEbayGate, EBAY_SELLER_LABEL } from "./ebay-gate.ts";
import { budgets, policyIdentity, type Offer } from "./vendor/domain.ts";

const USERNAME = "LEAKCHECK_seller_42",
  USER_ID = "LEAKUSERID9999";
const ids = ["v1|123456789012|0"];
const ebayItem = (itemId = ids[0]!) => ({
  itemId,
  gtin: "1234567890123",
  title: "Synthetic",
  conditionId: "1000",
  buyingOptions: ["FIXED_PRICE"],
  price: { value: "500.00", currency: "USD" },
  seller: {
    username: USERNAME,
    userId: USER_ID,
    sellerAccountType: "INDIVIDUAL",
    feedbackPercentage: "99.9",
    feedbackScore: 1000,
  },
  returnTerms: { returnsAccepted: true },
});
function watchesWithEbay(enabledEbay = true) {
  const watches = readPolicy(new URL("../fixtures/example-policy.json", import.meta.url).pathname);
  const w = watches[0]!;
  const ebay = w.bindings.find((b) => b.retailer === "ebay")!;
  Object.assign(ebay, { enabled: enabledEbay, productId: "1234567890123", ebayGtin: "1234567890123" });
  return { watches, w, ebay };
}

test("parser: label replaces the username, a missing username is accepted, feedback numbers stay", () => {
  const { w, ebay } = watchesWithEbay();
  const offer = parseEbay(ebayItem(), w, ebay, ids[0]!, 1000);
  expect(offer.seller).toEqual({ name: EBAY_SELLER_LABEL, established: false, percent: 99.9, score: 1000 });
  const bare = ebayItem();
  delete (bare.seller as Record<string, unknown>).username;
  expect(parseEbay(bare, w, ebay, ids[0]!, 1000).seller.name).toBe(EBAY_SELLER_LABEL);
  expect(JSON.stringify(offer)).not.toContain(USERNAME);
  expect(JSON.stringify(offer)).not.toContain(USER_ID);
});

test("Discord text for eBay never uses a seller name, even if an offer carried one", () => {
  const { w, ebay } = watchesWithEbay();
  const offer: Offer = {
    ...parseEbay(ebayItem(), w, ebay, ids[0]!, 1000),
    feesCents: 0,
    shippingCents: 0,
    shipping: "confirmed",
    availability: "in-stock",
    seller: { name: USERNAME, established: true, percent: 100, score: 100000 },
    warranty: "Synthetic",
  };
  const text = message(w, ebay, offer, crypto.randomUUID(), 1000);
  expect(text).not.toContain(USERNAME);
  expect(text).toContain("eBay listing");
});

test("leak: username and user id appear in no app request body and no log line in a full eBay cycle", async () => {
  const { watches, w } = watchesWithEbay();
  const version = policyIdentity(watches);
  const bodies: string[] = [];
  let step = 0;
  const fetcher = async (request: Request) => {
    const url = new URL(request.url);
    if (url.hostname === "receiver.test")
      return Response.json({ state: "CLEAR", storageDesignVersion: "tier1-v1", instanceId: "x" });
    if (url.hostname === "api.ebay.com") {
      if (request.method === "POST")
        return Response.json({ access_token: "synthetic", expires_in: 7200, token_type: "Application Access Token" });
      return Response.json(ebayItem(decodeURIComponent(url.pathname.split("/").at(-1)!)));
    }
    if (url.hostname !== "app.test") throw Error("Unexpected host");
    if (request.method === "POST") bodies.push(await request.clone().text());
    if (url.pathname === "/api/dashboard")
      return Response.json({
        policyVersion: version,
        watches: [{ id: w.id, preferences: { paused: false, muted: false, purchased: false } }],
      });
    if (url.pathname === "/api/checks/claim")
      return Response.json({
        policyVersion: version,
        lease: { leaseId: crypto.randomUUID(), task: { kind: "item", itemId: ids[step++ % 1] } },
      });
    return Response.json({ ok: true });
  };
  const logs: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    const worker = new Worker({
      baseUrl: "https://app.test",
      watches,
      random: () => 0,
      startupDelay: false,
      fetcher,
      ebayStateUrl: "http://receiver.test:3001",
      ebay: new EbayClient({ clientId: "synthetic", clientSecret: "synthetic" }, fetcher, () => 0),
    });
    await worker.runOnce();
  } finally {
    console.log = log;
    console.error = error;
  }
  expect(bodies.some((b) => b.includes(EBAY_SELLER_LABEL))).toBe(true);
  for (const text of [...bodies, ...logs]) {
    expect(text).not.toContain(USERNAME);
    expect(text).not.toContain(USER_ID);
  }
});

// ---- Stage D: the gate -------------------------------------------------------------------

type Gate = "clear" | "blocked" | "error" | "timeout" | "version" | "garbage" | "absent";
function gateHarness(gate: Gate, snapshotOffer?: unknown) {
  const { watches, w, ebay } = watchesWithEbay();
  const version = policyIdentity(watches);
  const sony = w.bindings.find((b) => b.retailer === "sony")!;
  const claims: string[] = [],
    completes: Record<string, unknown>[] = [],
    statuses: Record<string, unknown>[] = [],
    outbox: Record<string, unknown>[] = [],
    discord: string[] = [];
  let sonyCalls = 0;
  const event = {
    id: crypto.randomUUID(),
    lease_id: crypto.randomUUID(),
    watch_id: w.id,
    binding_id: ebay.id,
    offer_id: ids[0]!,
    policy_version: version,
    attempts: 1,
  };
  const fetcher = async (request: Request) => {
    const url = new URL(request.url);
    if (url.hostname === "receiver.test") {
      if (gate === "error") return new Response("x", { status: 500 });
      if (gate === "timeout") throw new DOMException("timeout", "TimeoutError");
      if (gate === "garbage") return new Response("<html>");
      const base = { storageDesignVersion: gate === "version" ? "tier0" : "tier1-v1", instanceId: "x" };
      return Response.json(gate === "blocked" ? { state: "BLOCKED", reason: "unprocessed", ...base } : { state: "CLEAR", ...base });
    }
    if (url.hostname === "discord.com") {
      discord.push(((await request.json()) as { content: string }).content);
      return Response.json({ id: "1" });
    }
    if (url.hostname === "api.direct.playstation.com") {
      sonyCalls++;
      return new Response("{}", { status: 500 });
    }
    if (url.hostname !== "app.test") throw Error("Unexpected host " + url.hostname);
    if (url.pathname === "/api/dashboard")
      return Response.json({
        policyVersion: version,
        watches: [
          {
            id: w.id,
            preferences: { paused: false, muted: false, purchased: false },
            sources: snapshotOffer ? [{ id: ebay.id, retailer: "ebay", offers: [{ offer: snapshotOffer }] }] : [],
            history: [],
          },
        ],
      });
    const body = request.method === "POST" ? await request.json() : {};
    if (url.pathname === "/api/integrations/status") statuses.push(body);
    if (url.pathname === "/api/checks/claim") {
      claims.push((body as { bindingId: string }).bindingId);
      return Response.json({ policyVersion: version, lease: { leaseId: crypto.randomUUID(), task: { kind: "search" } } });
    }
    if (url.pathname === "/api/checks/complete") completes.push(body);
    if (url.pathname === "/api/outbox/claim") return Response.json({ policyVersion: version, event });
    if (url.pathname === "/api/outbox/complete") outbox.push(body);
    return Response.json({ ok: true });
  };
  const worker = new Worker({
    baseUrl: "https://app.test",
    watches,
    random: () => 0,
    startupDelay: false,
    fetcher,
    webhook: "https://discord.com/api/webhooks/123/testing-placeholder-not-a-real-token",
    ebayStateUrl: gate === "absent" ? undefined : "http://receiver.test:3001",
    ebay: new EbayClient({ clientId: "synthetic", clientSecret: "synthetic" }, fetcher, () => 0),
  });
  return { worker, claims, completes, statuses, outbox, discord, sony, ebay, sonyCalls: () => sonyCalls };
}

for (const gate of ["blocked", "error", "timeout", "version", "garbage", "absent"] as const) {
  test(`gate ${gate}: eBay group skipped before any lease, Sony still runs, eBay event retried 1h, dashboard told`, async () => {
    const h = gateHarness(gate);
    await h.worker.runOnce();
    expect(h.claims).toEqual([h.sony.id]);
    expect(h.sonyCalls()).toBe(1);
    expect(h.discord).toEqual([]);
    expect(h.outbox).toHaveLength(1);
    expect(h.outbox[0]).toMatchObject({ status: "retry", result: "compliance-blocked", delayMs: 3_600_000 });
    const ebay = h.statuses[0]!.ebay as { state: string; reason: string };
    expect(ebay.state).toBe("blocked");
    expect(ebay.reason).toMatch(/^[a-z0-9-]{1,40}$/);
  });
}

test("gate reasons: receiver reason passes through, other failures use fixed codes", async () => {
  expect((await gateHarnessReason("blocked"))).toBe("unprocessed");
  expect((await gateHarnessReason("version"))).toBe("storage-version-mismatch");
  expect((await gateHarnessReason("absent"))).toBe("state-url-missing");
  expect((await gateHarnessReason("error"))).toBe("state-unreachable");
  expect((await gateHarnessReason("garbage"))).toBe("state-unreachable");
});
async function gateHarnessReason(gate: Gate) {
  const h = gateHarness(gate);
  await h.worker.runOnce();
  return (h.statuses[0]!.ebay as { reason: string }).reason;
}

test("CLEAR: eBay claims proceed and the dashboard is told clear", async () => {
  const h = gateHarness("clear");
  await h.worker.runOnce();
  expect(h.claims.sort()).toEqual([h.ebay.id, h.sony.id].sort());
  expect(h.statuses[0]!.ebay).toEqual({ state: "clear" });
  expect(h.outbox[0]).not.toMatchObject({ result: "compliance-blocked" });
});

test("no enabled eBay binding: no state read and no eBay field reported", async () => {
  const { watches } = watchesWithEbay(false);
  const reads: string[] = [];
  const version = policyIdentity(watches);
  const statuses: Record<string, unknown>[] = [];
  const fetcher = async (request: Request) => {
    const url = new URL(request.url);
    if (url.hostname === "receiver.test") reads.push(url.href);
    if (url.pathname === "/api/dashboard")
      return Response.json({ policyVersion: version, watches: [{ id: watches[0]!.id, preferences: { paused: false, muted: false, purchased: false } }] });
    if (url.pathname === "/api/integrations/status") statuses.push(await request.json());
    return Response.json({ ok: true, policyVersion: version, lease: null, event: null });
  };
  await new Worker({ baseUrl: "https://app.test", watches, fetcher, startupDelay: true }).runOnce();
  expect(reads).toEqual([]);
  expect(statuses[0]).not.toHaveProperty("ebay");
});

test("Tier 1 audit: a served eBay offer with a name other than the label, or an extra key, blocks eBay", async () => {
  const { w, ebay } = watchesWithEbay();
  const good = parseEbay(ebayItem(), w, ebay, ids[0]!, 1000);
  const wrap = (offer: unknown) => ({ watches: [{ sources: [{ id: "e", retailer: "ebay", offers: [{ offer }] }], history: [] }] });
  expect(auditEbayOffers(wrap(good))).toBe(true);
  expect(auditEbayOffers(wrap({ ...good, seller: { ...good.seller, name: USERNAME } }))).toBe(false);
  expect(auditEbayOffers(wrap({ ...good, userId: USER_ID }))).toBe(false);
  expect(auditEbayOffers(wrap({ ...good, seller: { ...good.seller, username: USERNAME } }))).toBe(false);
  expect(auditEbayOffers({ watches: [{ sources: [{ id: "e", retailer: "ebay", offers: [] }], history: [{ binding_id: "e", offer: { ...good, seller: { ...good.seller, name: USERNAME } } }] }] })).toBe(false);
  // Other retailers keep their seller names.
  expect(auditEbayOffers({ watches: [{ sources: [{ id: "s", retailer: "sony", offers: [{ offer: { ...good, seller: { ...good.seller, name: "Sony" } } }] }], history: [] }] })).toBe(true);
  const h = gateHarness("clear", { ...good, seller: { ...good.seller, name: USERNAME } });
  await h.worker.runOnce();
  expect(h.statuses[0]!.ebay).toEqual({ state: "blocked", reason: "tier1-audit" });
  expect(h.claims).toEqual([h.sony.id]);
  expect(JSON.stringify(h.statuses)).not.toContain(USERNAME);
});

test("readEbayGate: a hostile reason string is replaced by a fixed code", async () => {
  const gate = await readEbayGate("http://receiver.test:3001", async () =>
    Response.json({ state: "BLOCKED", reason: USERNAME + " <script>", storageDesignVersion: "tier1-v1" }),
  );
  expect(gate).toEqual({ state: "BLOCKED", reason: "state-invalid" });
  expect(budgets.ebay).toBeGreaterThan(0);
});
