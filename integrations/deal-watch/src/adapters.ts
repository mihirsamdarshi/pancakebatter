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
    o.shipping = "policy-supported";
  }
  // Free standard shipping does not establish mandatory fees. In particular,
  // battery-embedded products can incur a separate California recycling fee.
  // Keep fees unknown until destination/product-specific cost evidence exists.
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
export async function parseCostco(
  body: string,
  w: Watch,
  b: Binding,
  now = Date.now(),
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
  // Public JSON-LD does not establish ZIP shipping, mandatory membership cost or fresh bundle component values.
  // Keep those unknown; this adapter cannot generate a qualifying Costco deal yet.
  return parseOffer(o, now);
}
export async function collect(
  w: Watch,
  b: Binding,
  fetcher?: Fetcher,
  now = Date.now(),
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
    return parseCostco(await getPublic(purchaseUrl(b), fetcher), w, b, now);
  throw new UpstreamError("unsupported");
}
