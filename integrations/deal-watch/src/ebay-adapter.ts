import { parseOffer, type Offer, type Watch, type Binding } from "./vendor/domain.ts";
import { invalid, type InvalidReason } from "./http.ts";
import { EBAY_SELLER_LABEL } from "./ebay-gate.ts";
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown) =>
  typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 250) : null;
function money(v: unknown): number | null {
  if (
    !object(v) ||
    v.currency !== "USD" ||
    typeof v.value !== "string" ||
    !/^\d+(\.\d{1,2})?$/.test(v.value)
  )
    return null;
  const [whole, fraction = ""] = v.value.split(".");
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(n) && n <= 100000000 ? n : null;
}
/** eBay's "this seller is currently away" notices: 11509 carries a return date, 11508 does not. */
const SELLER_AWAY = [11508, 11509];
/**
 * Fail closed on any warning, except the `allowed` ids, and only when every warning is a well-formed object with
 * an integer `errorId`. Returns true when it accepted at least one allowed warning. The log reason carries only
 * eBay's numeric `errorId` values (at most 5), never message text or the return date.
 */
function rejectWarnings(value: unknown, allowed: readonly number[] = []): boolean {
  if (!object(value)) throw invalid("schema");
  if (value.warnings === undefined) return false;
  if (!Array.isArray(value.warnings)) throw invalid("warnings");
  if (value.warnings.length === 0) return false;
  if (
    value.warnings.every(
      (w) => object(w) && Number.isSafeInteger(w.errorId) && allowed.includes(w.errorId as number),
    )
  )
    return true;
  const codes = value.warnings
    .map((w) => (object(w) ? w.errorId : undefined))
    .filter((n): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
    .slice(0, 5);
  throw invalid(codes.length ? (`warnings:${codes.join(",")}` as InvalidReason) : "warnings");
}
const hasErrors = (value: Record<string, unknown>) =>
  value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.length > 0);
export function discoveryIds(value: unknown): string[] {
  rejectWarnings(value);
  if (!object(value)) throw invalid("schema");
  if (hasErrors(value)) throw invalid("errors");
  if (value.total === 0 && value.itemSummaries === undefined) return [];
  if (!Array.isArray(value.itemSummaries) || value.itemSummaries.length > 10)
    throw invalid("schema");
  const ids = value.itemSummaries.map((item) =>
    object(item) && typeof item.itemId === "string" ? item.itemId : "",
  );
  if (ids.some((id) => !/^v1\|\d{9,20}\|\d{1,20}$/.test(id)) || new Set(ids).size !== ids.length)
    throw invalid("schema");
  return ids;
}
/** GTIN-8/12/13/14 are the same number with leading zeros; compare in 14-digit form. Anything else never matches. */
const gtin14 = (v: unknown): string | null =>
  typeof v === "string" && /^(\d{8}|\d{12,14})$/.test(v) ? v.padStart(14, "0") : null;
const sameGtin = (v: unknown, watch: string): boolean => {
  const a = gtin14(v);
  return a !== null && a === gtin14(watch);
};
/**
 * Identity: the item-level `gtin` decides when present (compared in 14-digit form, see `gtin14`). Only when it
 * is absent may `product.gtins` (Browse `Product.gtins`, string[]) contain the watch GTIN.
 */
function gtinReason(value: Record<string, unknown>, gtin: string): InvalidReason | null {
  if (value.gtin !== undefined) return sameGtin(value.gtin, gtin) ? null : "gtin-mismatch";
  const gtins = object(value.product) ? value.product.gtins : undefined;
  if (!Array.isArray(gtins) || gtins.length === 0) return "gtin-missing";
  return gtins.some((g) => sameGtin(g, gtin)) ? null : "gtin-mismatch";
}
/**
 * Fees are unknown (null) unless the owner-approved assumption holds (see `feeAssumed`); the Discord
 * text then says "fee assumed, not verified". Warranty is never inferred, so only new listings can qualify.
 */
export function parseEbay(
  value: unknown,
  w: Watch,
  b: Binding,
  itemId: string,
  now = Date.now(),
): Offer {
  // Owner decision 18: a seller-away listing is shown, never alerted. Its stock is unknown (see below).
  const sellerAway = rejectWarnings(value, SELLER_AWAY);
  if (!object(value)) throw invalid("schema");
  if (!b.ebayGtin) throw invalid("binding");
  if (value.itemId !== itemId) throw invalid("item-id");
  const identity = gtinReason(value, b.ebayGtin);
  if (identity) throw invalid(identity);
  if (
    !Array.isArray(value.buyingOptions) ||
    !value.buyingOptions.includes("FIXED_PRICE") ||
    value.buyingOptions.includes("AUCTION")
  )
    throw invalid("buying-option");
  if (hasErrors(value)) throw invalid("errors");
  const conditions: Record<string, Offer["condition"]> = {
    "1000": "new",
    "1500": "open-box",
    "2000": "refurbished",
    "2010": "refurbished",
    "2020": "refurbished",
    "2030": "refurbished",
    "2500": "refurbished",
  };
  const condition =
    typeof value.conditionId === "string" ? conditions[value.conditionId] : undefined;
  const price = money(value.price),
    title = text(value.title),
    seller = object(value.seller) ? value.seller : {};
  if (!condition) throw invalid("condition");
  if (!price)
    throw invalid(object(value.price) && value.price.currency !== "USD" ? "currency" : "price");
  if (!title) throw invalid("title");
  // Options whose delivery-location echo equals the watch ZIP (the only proof the cost is for this ZIP).
  const matched = Array.isArray(value.shippingOptions)
    ? value.shippingOptions
        .filter(object)
        .filter(
          (s) =>
            ["STANDARD", "EXPEDITED", "ONE_DAY", "ECONOMY"].includes(String(s.type)) &&
            object(s.shipToLocationUsedForEstimate) &&
            s.shipToLocationUsedForEstimate.country === "US" &&
            s.shipToLocationUsedForEstimate.postalCode === w.zip,
        )
    : [];
  const options = matched.map((s) => money(s.shippingCost)).filter((v): v is number => v !== null);
  // Owner decision (November 8, option B): extra fees are assumed to be 0, never verified.
  // Only when the item is in the US, no import charge or eco fee is shown, and a ZIP-matched
  // shipping option has a known cost. Fixed price and USD are enforced above and by money().
  const feeAssumed =
    object(value.itemLocation) &&
    value.itemLocation.country === "US" &&
    options.length > 0 &&
    matched.every((s) => s.importCharges === undefined) &&
    value.ecoParticipationFee === undefined;
  const states = Array.isArray(value.estimatedAvailabilities)
    ? value.estimatedAvailabilities
        .filter(object)
        .filter(
          (a) => Array.isArray(a.deliveryOptions) && a.deliveryOptions.includes("SHIP_TO_HOME"),
        )
        .map((a) => a.estimatedAvailabilityStatus)
    : [];
  const ended = typeof value.itemEndDate === "string" ? Date.parse(value.itemEndDate) : null;
  const observed =
    states.includes("OUT_OF_STOCK") || (ended !== null && Number.isFinite(ended) && ended <= now)
      ? "out-of-stock"
      : states.length > 0 &&
          states.every((s) => s === "IN_STOCK" || s === "LIMITED_STOCK") &&
          (ended === null || Number.isFinite(ended))
        ? "in-stock"
        : "unknown";
  // "unknown" is never in stock for qualify() and is not "verify", so an away seller can never alert. An ended
  // listing stays out-of-stock so the app still deletes it.
  const availability = sellerAway && observed === "in-stock" ? "unknown" : observed;
  const percent =
    typeof seller.feedbackPercentage === "string" && /^\d+(\.\d+)?$/.test(seller.feedbackPercentage)
      ? Number(seller.feedbackPercentage)
      : null;
  return parseOffer(
    {
      id: itemId,
      productId: b.productId,
      title,
      condition,
      currency: "USD",
      priceCents: price,
      shippingCents: options.length ? Math.min(...options) : null,
      feesCents: feeAssumed ? 0 : null,
      shipping: options.length ? "confirmed" : "unverified",
      zip: w.zip,
      availability,
      observedAt: now,
      seller: {
        // Tier 1: the raw username is never read. Feedback numbers and the fixed label only.
        name: EBAY_SELLER_LABEL,
        established: false,
        percent,
        score: typeof seller.feedbackScore === "number" ? seller.feedbackScore : null,
      },
      returns:
        object(value.returnTerms) && value.returnTerms.returnsAccepted === true
          ? "Returns accepted; verify current period and terms at retailer"
          : null,
      warranty: null,
      extras: [],
    },
    now,
  );
}
