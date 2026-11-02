/** Shared, credential-free wire contract and qualification rules. Integer USD cents only. */
export const POLICY_VERSION = "2026-11-01.1";
export type Retailer = "sony" | "costco" | "bestbuy" | "target" | "ebay";
export const budgets: Record<Retailer, number> = {
  sony: 120_000,
  costco: 900_000,
  bestbuy: 300_000,
  target: 900_000,
  ebay: 300_000,
};
export type Condition = "new" | "open-box" | "refurbished" | "used";
export type Shipping = "confirmed" | "policy-supported" | "unverified" | "rejected";
export interface Binding {
  id: string;
  retailer: Retailer;
  productId: string;
  pagePath: string;
  enabled: boolean;
  note: string;
  shippingPolicyZips?: string[];
  bundleExtraIds?: string[];
  ebayGtin?: string;
}
export interface Watch {
  id: string;
  title: string;
  zip: string;
  currency: "USD";
  newCeilingCents: number;
  newReferenceCents: number;
  openBoxDiscountPercent: number;
  refurbishedDiscountPercent: number;
  minSellerPercent: number;
  minSellerScore: number;
  allowPolicyShipping: boolean;
  bindings: Binding[];
}
export interface Offer {
  id: string;
  productId: string;
  title: string;
  condition: Condition;
  currency: "USD";
  priceCents: number;
  shippingCents: number | null;
  feesCents: number | null;
  shipping: Shipping;
  zip: string;
  availability: "in-stock" | "out-of-stock" | "unknown";
  observedAt: number;
  seller: {
    name: string;
    established: boolean;
    percent: number | null;
    score: number | null;
  };
  returns: string | null;
  warranty: string | null;
  extras: {
    id: string;
    quantity: number;
    referenceCents: number | null;
    referenceAt: number | null;
  }[];
}
export interface Qualification {
  eligible: boolean;
  reasons: string[];
  totalCents: number | null;
  ceilingCents: number;
  referenceCents: number;
}
export const cents = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 100_000_000;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 250): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;
const nullableText = (v: unknown) => v === null || text(v, 500);

export function validateWatch(w: Watch): void {
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(w.id) ||
    !text(w.title) ||
    !/^\d{5}$/.test(w.zip) ||
    w.currency !== "USD" ||
    !cents(w.newCeilingCents) ||
    !cents(w.newReferenceCents) ||
    w.newCeilingCents > w.newReferenceCents ||
    ![w.openBoxDiscountPercent, w.refurbishedDiscountPercent, w.minSellerPercent].every(
      (n) => Number.isFinite(n) && n >= 0 && n <= 100,
    ) ||
    !cents(w.minSellerScore) ||
    typeof w.allowPolicyShipping !== "boolean" ||
    !w.bindings.length
  )
    throw new Error("Invalid watch configuration");
  const ids = new Set<string>();
  for (const b of w.bindings) {
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(b.id) ||
      ids.has(b.id) ||
      !["sony", "costco", "bestbuy", "target", "ebay"].includes(b.retailer) ||
      !/^\d{1,30}$/.test(b.productId) ||
      !/^\/[a-zA-Z0-9/._-]{1,240}$/.test(b.pagePath) ||
      b.pagePath.includes("..") ||
      b.pagePath.startsWith("//") ||
      typeof b.enabled !== "boolean" ||
      !text(b.note, 600) ||
      (b.ebayGtin !== undefined && (b.retailer !== "ebay" || !/^\d{8,14}$/.test(b.ebayGtin))) ||
      (b.retailer === "ebay" && b.enabled && (!b.ebayGtin || b.productId !== b.ebayGtin)) ||
      (b.shippingPolicyZips &&
        (!Array.isArray(b.shippingPolicyZips) ||
          b.shippingPolicyZips.length > 50 ||
          !b.shippingPolicyZips.every((zip) => /^\d{5}$/.test(zip)))) ||
      (b.bundleExtraIds &&
        (!Array.isArray(b.bundleExtraIds) ||
          b.bundleExtraIds.length > 10 ||
          !b.bundleExtraIds.every((id) => /^[a-z0-9-]{1,64}$/.test(id))))
    )
      throw new Error("Invalid source binding");
    ids.add(b.id);
  }
}

export function parseOffer(value: unknown, now = Date.now()): Offer {
  if (!record(value)) throw new Error("Invalid observation");
  const v = value;
  if (
    !text(v.id, 100) ||
    !text(v.productId, 30) ||
    !text(v.title) ||
    typeof v.condition !== "string" ||
    !["new", "open-box", "refurbished", "used"].includes(v.condition) ||
    v.currency !== "USD" ||
    !cents(v.priceCents) ||
    v.priceCents === 0 ||
    !(v.shippingCents === null || cents(v.shippingCents)) ||
    !(v.feesCents === null || cents(v.feesCents)) ||
    typeof v.shipping !== "string" ||
    !["confirmed", "policy-supported", "unverified", "rejected"].includes(v.shipping) ||
    typeof v.zip !== "string" ||
    !/^\d{5}$/.test(v.zip) ||
    typeof v.availability !== "string" ||
    !["in-stock", "out-of-stock", "unknown"].includes(v.availability) ||
    !Number.isSafeInteger(v.observedAt) ||
    Number(v.observedAt) > now + 60_000 ||
    Number(v.observedAt) < now - 86_400_000 ||
    !record(v.seller) ||
    !text(v.seller.name) ||
    typeof v.seller.established !== "boolean" ||
    !(
      v.seller.percent === null ||
      (typeof v.seller.percent === "number" &&
        Number.isFinite(v.seller.percent) &&
        v.seller.percent >= 0 &&
        v.seller.percent <= 100)
    ) ||
    !(v.seller.score === null || cents(v.seller.score)) ||
    !nullableText(v.returns) ||
    !nullableText(v.warranty) ||
    !Array.isArray(v.extras) ||
    v.extras.length > 10
  )
    throw new Error("Invalid observation fields");
  for (const e of v.extras) {
    if (
      !record(e) ||
      !text(e.id, 64) ||
      !Number.isSafeInteger(e.quantity) ||
      Number(e.quantity) < 1 ||
      Number(e.quantity) > 100 ||
      !(e.referenceCents === null || cents(e.referenceCents)) ||
      !(
        e.referenceAt === null ||
        (Number.isSafeInteger(e.referenceAt) && Number(e.referenceAt) <= now + 60_000)
      )
    )
      throw new Error("Invalid bundle evidence");
  }
  return {
    id: v.id,
    productId: v.productId,
    title: v.title,
    condition: v.condition,
    currency: v.currency,
    priceCents: v.priceCents,
    shippingCents: v.shippingCents,
    feesCents: v.feesCents,
    shipping: v.shipping,
    zip: v.zip,
    availability: v.availability,
    observedAt: v.observedAt,
    seller: {
      name: v.seller.name,
      established: v.seller.established,
      percent: v.seller.percent,
      score: v.seller.score,
    },
    returns: v.returns,
    warranty: v.warranty,
    extras: v.extras.map((e) => ({
      id: e.id,
      quantity: e.quantity,
      referenceCents: e.referenceCents,
      referenceAt: e.referenceAt,
    })),
  } as Offer;
}

/** Bounded collection boundary; an empty successful result is distinct from a source error. */
export const MAX_OFFERS_PER_SOURCE = 10;
export function parseOffers(value: unknown, now = Date.now()): Offer[] {
  if (!Array.isArray(value) || value.length > MAX_OFFERS_PER_SOURCE)
    throw new Error("Invalid offer collection");
  const offers = value.map((item) => parseOffer(item, now));
  const ids = new Set<string>();
  for (const offer of offers) {
    if (ids.has(offer.id)) throw new Error("Duplicate offer identity");
    ids.add(offer.id);
  }
  return offers;
}

/** Links are constructed from configured IDs, never an observation's supplied URL. */
export function purchaseUrl(binding: Binding, offer?: Offer): string {
  const hosts: Record<Retailer, string> = {
    sony: "direct.playstation.com",
    costco: "www.costco.com",
    bestbuy: "www.bestbuy.com",
    target: "www.target.com",
    ebay: "www.ebay.com",
  };
  if (binding.retailer === "ebay" && offer) {
    const rest = /^v1\|(\d{9,20})\|(\d{1,20})$/.exec(offer.id);
    if (rest)
      return `https://www.ebay.com/itm/${rest[1]}${rest[2] === "0" ? "" : "?var=" + rest[2]}`;
  }
  if (binding.retailer === "ebay" && offer && /^\d{1,30}$/.test(offer.id))
    return `https://www.ebay.com/itm/${offer.id}`;
  return `https://${hosts[binding.retailer]}${binding.pagePath}`;
}

export function qualify(w: Watch, b: Binding, o: Offer, now = Date.now()): Qualification {
  const reasons: string[] = [];
  if (!b.enabled) reasons.push("Source is disabled");
  if (o.productId !== b.productId) reasons.push("Product identity mismatch");
  if (o.zip !== w.zip) reasons.push("Destination mismatch");
  if (o.currency !== w.currency) reasons.push("Currency mismatch");
  if (o.observedAt < now - 15 * 60_000 || o.observedAt > now + 60_000)
    reasons.push("Observation is stale");
  if (o.availability !== "in-stock")
    reasons.push(o.availability === "out-of-stock" ? "Out of stock" : "Stock unverified");
  if (
    o.shipping === "rejected" ||
    o.shipping === "unverified" ||
    (o.shipping === "policy-supported" &&
      (!w.allowPolicyShipping || !b.shippingPolicyZips?.includes(w.zip)))
  )
    reasons.push("Shipping to destination unverified");
  const total =
    o.shippingCents !== null && o.feesCents !== null
      ? o.priceCents + o.shippingCents + o.feesCents
      : null;
  if (total === null) reasons.push("Shipping or mandatory fees unknown");
  if (
    !o.seller.established &&
    (o.seller.percent === null ||
      o.seller.percent < w.minSellerPercent ||
      o.seller.score === null ||
      o.seller.score < w.minSellerScore)
  )
    reasons.push("Seller needs review");
  if (!o.seller.established && !o.returns) reasons.push("Marketplace returns evidence missing");
  if (o.condition === "used") reasons.push("Ordinary used condition excluded");
  if (o.condition !== "new" && (!o.returns || !o.warranty))
    reasons.push("Returns or warranty evidence missing");
  let ceiling = w.newCeilingCents;
  if (o.condition === "open-box")
    ceiling = Math.min(
      ceiling,
      Math.floor((w.newReferenceCents * (100 - w.openBoxDiscountPercent)) / 100),
    );
  if (o.condition === "refurbished")
    ceiling = Math.min(
      ceiling,
      Math.floor((w.newReferenceCents * (100 - w.refurbishedDiscountPercent)) / 100),
    );
  const expected = [...(b.bundleExtraIds ?? [])].sort();
  const actual = o.extras.map((e) => e.id).sort();
  if (o.extras.some((e) => e.quantity !== 1)) reasons.push("Bundle quantities unverified");
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    reasons.push("Bundle contents unverified");
  let extraValue = 0;
  for (const e of o.extras) {
    if (e.referenceCents === null || e.referenceAt === null || e.referenceAt < now - 86_400_000)
      reasons.push("Bundle reference price missing or stale");
    else extraValue += e.referenceCents * e.quantity;
  }
  const reference = w.newReferenceCents + extraValue;
  if (expected.length) {
    ceiling = Math.min(ceiling + extraValue, reference - 1);
    if (total !== null && total >= reference)
      reasons.push("Bundle must cost less than its individual items");
  }
  if (total !== null && total > ceiling) reasons.push("Above price ceiling");
  return {
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    totalCents: total,
    ceilingCents: ceiling,
    referenceCents: reference,
  };
}

/** Stable, non-secret identity of the complete owner-approved product policy. */
export function policyIdentity(watches: Watch[]): string {
  function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
      );
    return v;
  }
  return `${POLICY_VERSION}:${new Bun.CryptoHasher("sha256").update(JSON.stringify(canonical(watches))).digest("hex")}`;
}
