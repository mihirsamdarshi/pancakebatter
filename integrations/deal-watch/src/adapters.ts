import { parseOffer, purchaseUrl, type Offer, type Watch, type Binding } from "./vendor/domain.ts";
import { getPublic, UpstreamError, type Fetcher } from "./http.ts";
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function price(value: unknown): number {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !/^\d+(\.\d{1,2})?$/.test(String(value))
  )
    throw new UpstreamError("invalid-data");
  const result = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(result) || result <= 0) throw new UpstreamError("invalid-data");
  return result;
}
function basic(w: Watch, b: Binding, now: number): Offer {
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
    seller: {
      name: b.retailer === "sony" ? "PlayStation Direct" : "Costco",
      established: true,
      percent: null,
      score: null,
    },
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
export function parseSony(body: string, w: Watch, b: Binding, now = Date.now()): Offer {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new UpstreamError("invalid-data");
  }
  if (!object(data) || !Array.isArray(data.products)) throw new UpstreamError("invalid-data");
  const matches = data.products.filter((p: unknown) => object(p) && p.code === b.productId);
  if (matches.length !== 1 || !object(matches[0])) throw new UpstreamError("invalid-data");
  const p = matches[0];
  if (
    p.validProductCode !== true ||
    typeof p.name !== "string" ||
    !object(p.price) ||
    p.price.currencyIso !== "USD" ||
    !object(p.stock) ||
    typeof p.stock.stockLevelStatus !== "string"
  )
    throw new UpstreamError("invalid-data");
  const o = basic(w, b, now);
  o.title = p.name;
  o.priceCents = price(p.price.value);
  const stock = p.stock.stockLevelStatus;
  o.availability =
    stock === "outOfStock"
      ? "out-of-stock"
      : stock === "inStock" &&
          p.purchasable === true &&
          p.preOrderProduct === false &&
          p.loginGated === false &&
          p.psPlusGated === false
        ? "in-stock"
        : "unknown";
  // maxOrderQuantity is an order limit, never inventory evidence.
  // The reviewed standard-shipping policy covers the contiguous US for orders > $40.
  // Other ZIPs/products need their own shipping proof rather than inheriting this assumption.
  if (
    b.shippingPolicyZips?.includes(w.zip) &&
    o.priceCents > 4000 &&
    p.isMilitaryRestricted !== true
  ) {
    o.shippingCents = 0;
    o.feesCents = 0;
    o.shipping = "policy-supported";
  }
  return parseOffer(o, now);
}
async function productJsonLd(body: string): Promise<Record<string, unknown>[]> {
  const scripts: string[] = [];
  let current = "";
  const rw = new HTMLRewriter().on('script[type="application/ld+json"]', {
    element(el) {
      current = "";
      el.onEndTag(() => {
        scripts.push(current);
      });
    },
    text(chunk) {
      current += chunk.text;
    },
  });
  await rw.transform(new Response(body)).text();
  const products: Record<string, unknown>[] = [];
  function walk(node: unknown, depth = 0): void {
    if (depth > 16) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    if (!object(node)) return;
    if (
      node["@type"] === "Product" ||
      (Array.isArray(node["@type"]) && node["@type"].includes("Product"))
    )
      products.push(node);
    if (node["@graph"]) walk(node["@graph"], depth + 1);
  }
  for (const script of scripts) {
    try {
      walk(JSON.parse(script));
    } catch {
      /* unrelated malformed metadata is not product evidence */
    }
  }
  return products;
}
/** Extra-item reference prices younger than this are usable (matches `qualify`'s 24 hour rule). */
export const REFERENCE_MAX_AGE_MS = 86_400_000;
export type ReferenceMap = ReadonlyMap<string, { cents: number; at: number }>;
/**
 * Sony Direct product codes whose price is the reference price of a bundle extra, in preference order.
 * 1000050331 is the Gray Camouflage controller part number and is unverified on Sony Direct.
 * 1000050328 is the standard white DualSense (a real Sony response showed USD 74.00, in stock).
 * The white controller is a fallback only: it is used when the exact gray product is not valid in the response.
 */
export const EXTRA_REFERENCE_CODES: Readonly<Record<string, readonly string[]>> = {
  "dualsense-grey-camo": ["1000050331", "1000050328"],
};
/** Distinct Sony codes needed for the given extra IDs, in mapping order. */
export function referenceCodes(extraIds: readonly string[]): string[] {
  const codes: string[] = [];
  for (const id of extraIds)
    for (const c of EXTRA_REFERENCE_CODES[id] ?? []) if (!codes.includes(c)) codes.push(c);
  return codes;
}
/** Pure parser: per extra ID, the price of the first mapped code that is valid with a USD price. Never throws. */
export function parseReferences(body: string, extraIds: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  let products: unknown[];
  try {
    const data: unknown = JSON.parse(body);
    if (!object(data) || !Array.isArray(data.products)) return out;
    products = data.products;
  } catch {
    return out;
  }
  for (const id of extraIds)
    for (const code of EXTRA_REFERENCE_CODES[id] ?? []) {
      const p = products.find((x) => object(x) && x.code === code);
      if (!object(p) || p.validProductCode !== true || !object(p.price)) continue;
      if (p.price.currencyIso !== "USD") continue;
      try {
        out.set(id, price(p.price.value));
        break;
      } catch {
        /* invalid price: try the next preferred code */
      }
    }
  return out;
}
/** One request for all codes. Stock is irrelevant for a reference price. Throws only UpstreamError from transport. */
export async function fetchReferences(
  extraIds: readonly string[],
  fetcher?: Fetcher,
): Promise<Map<string, number>> {
  const codes = referenceCodes(extraIds);
  if (codes.length === 0) return new Map();
  const url =
    "https://api.direct.playstation.com/commercewebservices/ps-direct-us/products/productList" +
    `?fields=BASIC&productCodes=${codes.join(",")}`;
  return parseReferences(await getPublic(url, fetcher), extraIds);
}
export async function parseCostco(
  body: string,
  w: Watch,
  b: Binding,
  now = Date.now(),
  references: ReferenceMap = new Map(),
): Promise<Offer> {
  if (/<title>\s*(Robot or human|Access Denied|Just a moment)/i.test(body))
    throw new UpstreamError("access-denied");
  const products = (await productJsonLd(body)).filter(
    (p) =>
      (typeof p.sku === "string" || typeof p.sku === "number") && String(p.sku) === b.productId,
  );
  if (products.length !== 1) throw new UpstreamError("invalid-data");
  const p = products[0]!,
    offers = Array.isArray(p.offers) ? p.offers : [p.offers];
  if (offers.length !== 1 || !object(offers[0]) || typeof p.name !== "string")
    throw new UpstreamError("invalid-data");
  const value = offers[0];
  if (value.priceCurrency !== "USD" || typeof value.availability !== "string")
    throw new UpstreamError("invalid-data");
  const o = basic(w, b, now);
  o.title = p.name;
  o.priceCents = price(value.price);
  o.availability = /\/OutOfStock$/.test(value.availability)
    ? "out-of-stock"
    : /\/InStock$/.test(value.availability)
      ? "in-stock"
      : "unknown";
  // Assumption (owner decision): the listing says standard shipping is included, the owner holds an active
  // membership, and free policy shipping means zero other mandatory fees, as in the Sony adapter. The
  // California recycling fee is outside the owner's ceiling. Other ZIPs stay unknown.
  if (b.shippingPolicyZips?.includes(w.zip) && o.priceCents > 4000) {
    o.shippingCents = 0;
    o.feesCents = 0;
    o.shipping = "policy-supported";
  }
  // Extras carry a reference only while the entry is fresh; otherwise qualify() reports it missing or stale.
  for (const e of o.extras) {
    const r = references.get(e.id);
    if (r && r.at <= now && r.at >= now - REFERENCE_MAX_AGE_MS) {
      e.referenceCents = r.cents;
      e.referenceAt = r.at;
    }
  }
  return parseOffer(o, now);
}
export async function collect(
  w: Watch,
  b: Binding,
  fetcher?: Fetcher,
  now = Date.now(),
  references: ReferenceMap = new Map(),
): Promise<Offer> {
  if (b.retailer === "sony") {
    const url = new URL(
      "https://api.direct.playstation.com/commercewebservices/ps-direct-us/products/productList",
    );
    url.searchParams.set("fields", "BASIC");
    url.searchParams.set("productCodes", b.productId);
    return parseSony(await getPublic(url.href, fetcher), w, b, now);
  }
  if (b.retailer === "costco")
    return parseCostco(await getPublic(purchaseUrl(b), fetcher), w, b, now, references);
  throw new UpstreamError("unsupported");
}
