import { parseOffer, type Offer, type Watch, type Binding } from "./vendor/domain.ts";
import { boundedText, nativeFetch, retryAfter, UpstreamError, type Fetcher } from "./http.ts";

/** Browser-backed retailers. The browser service loads one public product page per request and returns allowlisted JSON. */
export type BrowserRetailer = "target" | "bestbuy";
export const BROWSER_TIMEOUT_MS = 120_000;
/** The service returns at most 12 bodies of at most 1 MiB each. */
export const MAX_OBSERVATION_BYTES = 13 * 1024 * 1024;
const ALLOWED_PATHS: Record<BrowserRetailer, readonly string[]> = {
  target: ["/cdui_orchestrations/v1/pages/pdp/deferred_enrichment/modules"],
  bestbuy: ["/gateway/graphql", "/gateway/graphql/fulfillment"],
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const invalid = () => new UpstreamError("invalid-data");

/** `BROWSER_URL`: http(s) origin only. No credentials, query, fragment or path. Returns it without a trailing slash. */
export function parseBrowserUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("BROWSER_URL must be an http or https origin");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    value.includes("?") ||
    value.includes("#")
  )
    throw new Error("BROWSER_URL must be an http or https origin");
  return url.origin;
}

/** Page paths the browser service accepts. The service builds the URL itself; the worker checks first. */
export function validPagePath(retailer: BrowserRetailer, productId: string, path: string): boolean {
  if (!/^\d{1,20}$/.test(productId)) return false;
  return retailer === "target"
    ? path === `/p/-/A-${productId}`
    : new RegExp(`^/product/[a-z0-9-]{1,120}/[A-Z0-9]{6,16}/sku/${productId}$`).test(path);
}

/**
 * One page load through the browser service. Returns the parsed JSON document; shape checks happen in the parsers.
 * Service 429 means busy (throttled); the worker's retailer backoff then applies.
 */
export async function observe(
  browserUrl: string,
  retailer: BrowserRetailer,
  productId: string,
  pagePath: string,
  fetcher: Fetcher = nativeFetch,
  timeoutMs = BROWSER_TIMEOUT_MS,
): Promise<unknown> {
  const base = parseBrowserUrl(browserUrl);
  if (!validPagePath(retailer, productId, pagePath)) throw invalid();
  let res: Response;
  try {
    res = await fetcher(
      new Request(`${base}/observe`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ retailer, productId, path: pagePath }),
      }),
    );
    if (res.status === 429) {
      await res.body?.cancel();
      throw new UpstreamError("throttled", retryAfter(res.headers.get("retry-after")));
    }
    if (res.status === 400) {
      await res.body?.cancel();
      throw invalid();
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new UpstreamError("network");
    }
    const text = await boundedText(res, MAX_OBSERVATION_BYTES);
    try {
      return JSON.parse(text);
    } catch {
      throw invalid();
    }
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError("network");
  }
}

interface Captured {
  path: string;
  body: unknown;
}
/** Checks the service answer belongs to this binding and returns the allowlisted 200 bodies. */
function captured(value: unknown, b: Binding): Captured[] {
  if (!object(value)) throw invalid();
  if (value.blocked === true) throw new UpstreamError("access-denied");
  if (value.blocked !== false) throw invalid();
  if (value.error !== null && value.error !== undefined) throw new UpstreamError("network");
  if (value.status === 429) throw new UpstreamError("throttled");
  if (value.status === 401 || value.status === 403) throw new UpstreamError("access-denied");
  if (value.status !== 200) throw new UpstreamError("network");
  if (value.retailer !== b.retailer || value.productId !== b.productId) throw invalid();
  if (!Array.isArray(value.responses) || value.responses.length > 12) throw invalid();
  const allowed = ALLOWED_PATHS[b.retailer as BrowserRetailer];
  const out: Captured[] = [];
  for (const r of value.responses) {
    if (!object(r) || typeof r.path !== "string" || typeof r.status !== "number") throw invalid();
    if (r.status === 200 && allowed.includes(r.path)) out.push({ path: r.path, body: r.body });
  }
  return out;
}

/** USD price in whole cents from a JSON number or a "$1,234.56" label. Anything else is invalid. */
function usdCents(value: unknown): number {
  let text: string;
  if (typeof value === "number") text = String(value);
  else if (typeof value === "string" && /^\$(\d{1,3}(,\d{3})+|\d+)(\.\d{2})?$/.test(value))
    text = value.slice(1).replaceAll(",", "");
  else throw invalid();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw invalid();
  const result = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(result) || result <= 0) throw invalid();
  return result;
}
function single<T>(values: T[]): T {
  const distinct = [...new Set(values)];
  if (distinct.length !== 1) throw invalid();
  return distinct[0]!;
}
const empty = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === false ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (object(v) && Object.keys(v).length === 0);
/** True when any key naming a seller, vendor or marketplace holds a value. Fail-closed for unknown third parties. */
function thirdPartyKey(node: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (Array.isArray(node)) return node.some((n) => thirdPartyKey(n, depth + 1));
  if (!object(node)) return false;
  for (const [k, v] of Object.entries(node)) {
    if (k === "esp") continue; // protection-plan offer attached to the product, not the product's seller
    if (/seller|vendor|marketplace|third_?party|sold_?by|partner/i.test(k) && !empty(v)) return true;
    if (thirdPartyKey(v, depth + 1)) return true;
  }
  return false;
}
function base(w: Watch, b: Binding, now: number, name: string): Offer {
  return {
    id: b.productId,
    productId: b.productId,
    title: w.title,
    condition: "new",
    currency: "USD",
    priceCents: 1,
    shippingCents: null,
    feesCents: null,
    shipping: "unverified",
    zip: w.zip,
    availability: "unknown",
    observedAt: now,
    seller: { name, established: true, percent: null, score: null },
    returns: null,
    warranty: null,
    extras: (b.bundleExtraIds ?? []).map((id) => ({
      id,
      quantity: 1,
      referenceCents: null,
      referenceAt: null,
    })),
  };
}
/**
 * Assumption (owner decision), the same as the Sony and Costco adapters: standard shipping is free over $35
 * and free policy shipping means no other mandatory fees. The owner's ceiling excludes the California recycling
 * fee. The ship-to ZIP the retailer shows comes from the browser's IP address and is not the watch ZIP, so only
 * the owner-reviewed ZIP list can back this. Other ZIPs keep unknown shipping and fees.
 */
function policyShipping(o: Offer, w: Watch, b: Binding): void {
  if (b.shippingPolicyZips?.includes(w.zip) && o.priceCents > 4000) {
    o.shippingCents = 0;
    o.feesCents = 0;
    o.shipping = "policy-supported";
    o.zip = w.zip;
  }
}

/** Target: `modules[].module_data.data.product` objects whose own `tcin` is the binding's TCIN. */
export function parseTarget(
  observation: unknown,
  w: Watch,
  b: Binding,
  now = Date.now(),
): Offer {
  const products: Record<string, unknown>[] = [];
  for (const r of captured(observation, b)) {
    if (!object(r.body) || !Array.isArray(r.body.modules)) continue;
    for (const m of r.body.modules) {
      const product =
        object(m) && object(m.module_data) && object(m.module_data.data)
          ? m.module_data.data.product
          : undefined;
      if (object(product) && String(product.tcin) === b.productId) products.push(product);
    }
  }
  if (products.length === 0) throw invalid();
  const fulfillments = products.flatMap((p) => (p.fulfillment === undefined ? [] : [p.fulfillment]));
  const shipping = fulfillments.map((f) => {
    if (
      !object(f) ||
      (f.product_id !== undefined && String(f.product_id) !== b.productId) ||
      !object(f.shipping_options) ||
      typeof f.shipping_options.availability_status !== "string"
    )
      throw invalid();
    return f.shipping_options;
  });
  const status = single(shipping.map((s) => s.availability_status as string));
  const prices = products.flatMap((p) => (p.price === undefined ? [] : [p.price]));
  const priceCents = single(
    prices.map((p) => {
      if (!object(p)) throw invalid();
      const label = usdCents(p.formatted_current_price);
      if (p.current_retail !== undefined && usdCents(p.current_retail) !== label) throw invalid();
      return label;
    }),
  );
  // The binding's TCIN must be Target's own listing. Target Plus partner items use separate TCINs and the
  // allowlisted data carries no seller field, so the check below can only catch explicit seller keys.
  const o = base(w, b, now, "Target");
  o.priceCents = priceCents;
  o.availability =
    status === "IN_STOCK" ? "in-stock" : status === "OUT_OF_STOCK" ? "out-of-stock" : "unknown";
  // Contradicting inventory evidence never counts as stock.
  if (
    o.availability === "in-stock" &&
    (fulfillments.some((f) => object(f) && f.sold_out === true) ||
      shipping.some((s) => s.available_to_promise_quantity === 0))
  )
    o.availability = "unknown";
  // The captured data carries no seller field: Target's own items have no seller key at all. Any
  // seller, vendor, marketplace or partner value in the product means a third party and is rejected.
  o.seller.established = !products.some((p) => thirdPartyKey(p));
  policyShipping(o, w, b);
  return parseOffer(o, now);
}

/** Best Buy: `data.productBySkuId` objects whose own `skuId` is the binding's SKU, plus its `fulfillmentOptions`. */
export function parseBestBuy(
  observation: unknown,
  w: Watch,
  b: Binding,
  now = Date.now(),
): Offer {
  const products: Record<string, unknown>[] = [];
  const buttons: string[] = [];
  const eligible: unknown[] = [];
  for (const r of captured(observation, b)) {
    const data = object(r.body) ? r.body.data : undefined;
    if (!object(data)) continue;
    if (object(data.productBySkuId) && data.productBySkuId.skuId === b.productId)
      products.push(data.productBySkuId);
    const options = data.fulfillmentOptions;
    if (object(options)) {
      for (const s of Array.isArray(options.buttonStates) ? options.buttonStates : [])
        if (
          object(s) &&
          s.skuId === b.productId &&
          s.condition === "NEW" &&
          typeof s.buttonState === "string"
        )
          buttons.push(s.buttonState);
      for (const d of Array.isArray(options.shippingDetails) ? options.shippingDetails : [])
        if (object(d) && d.sku === b.productId && Array.isArray(d.shippingAvailability))
          for (const a of d.shippingAvailability)
            if (object(a) && a.condition === "NEW") eligible.push(a.shippingEligible);
    }
  }
  if (products.length === 0) throw invalid();
  const priceCents = single(
    products.flatMap((p) =>
      object(p.price) && p.price.customerPrice !== undefined
        ? [usdCents(p.price.customerPrice)]
        : [],
    ),
  );
  const state = single(buttons);
  const o = base(w, b, now, "Best Buy");
  const names = products.flatMap((p) =>
    object(p.name) && typeof p.name.short === "string" && p.name.short ? [p.name.short] : [],
  );
  if (names.length > 0) o.title = single(names);
  o.priceCents = priceCents;
  o.availability =
    state === "ADD_TO_CART" ? "in-stock" : state === "SOLD_OUT" ? "out-of-stock" : "unknown";
  // Explicit shipping ineligibility, or a conflict, means the button is not proof of a shippable unit.
  if (o.availability === "in-stock" && eligible.some((e) => e === false)) o.availability = "unknown";
  // First-party proof: seller.classification "1P", or seller id "bby" with marketplaceSeller null. Any
  // marketplace seller, another classification or another id rejects. No seller data at all also rejects.
  let firstParty = false,
    marketplace = false;
  for (const p of products) {
    if (!object(p.seller)) continue;
    const s = p.seller;
    if (s.marketplaceSeller !== null && s.marketplaceSeller !== undefined) marketplace = true;
    if (s.classification !== undefined) {
      if (s.classification === "1P") firstParty = true;
      else marketplace = true;
    }
    if (s.id !== undefined) {
      if (s.id === "bby" && s.marketplaceSeller === null) firstParty = true;
      else if (s.id !== "bby") marketplace = true;
    }
  }
  o.seller.established = firstParty && !marketplace;
  policyShipping(o, w, b);
  return parseOffer(o, now);
}
