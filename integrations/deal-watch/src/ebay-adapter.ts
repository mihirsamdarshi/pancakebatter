import { parseOffer, type Offer, type Watch, type Binding } from "./vendor/domain.ts";
import { UpstreamError } from "./http.ts";
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
function rejectWarnings(value: unknown): void {
  if (
    !object(value) ||
    (value.warnings !== undefined && (!Array.isArray(value.warnings) || value.warnings.length > 0))
  )
    throw new UpstreamError("invalid-data");
}
export function discoveryIds(value: unknown): string[] {
  rejectWarnings(value);
  if (
    !object(value) ||
    (value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.length))
  )
    throw new UpstreamError("invalid-data");
  if (value.total === 0 && value.itemSummaries === undefined) return [];
  if (!Array.isArray(value.itemSummaries) || value.itemSummaries.length > 10)
    throw new UpstreamError("invalid-data");
  const ids = value.itemSummaries.map((item) =>
    object(item) && typeof item.itemId === "string" ? item.itemId : "",
  );
  if (ids.some((id) => !/^v1\|\d{9,20}\|\d{1,20}$/.test(id)) || new Set(ids).size !== ids.length)
    throw new UpstreamError("invalid-data");
  return ids;
}
/** No unverified mandatory-fee or warranty inference. This adapter remains nonqualifying until fee proof exists. */
export function parseEbay(
  value: unknown,
  w: Watch,
  b: Binding,
  itemId: string,
  now = Date.now(),
): Offer {
  rejectWarnings(value);
  if (
    !object(value) ||
    !b.ebayGtin ||
    value.itemId !== itemId ||
    value.gtin !== b.ebayGtin ||
    !Array.isArray(value.buyingOptions) ||
    !value.buyingOptions.includes("FIXED_PRICE") ||
    value.buyingOptions.includes("AUCTION") ||
    (value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.length))
  )
    throw new UpstreamError("invalid-data");
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
  if (!condition || !price || !title)
    throw new UpstreamError("invalid-data");
  const options = Array.isArray(value.shippingOptions)
    ? value.shippingOptions
        .filter(object)
        .filter(
          (s) =>
            ["STANDARD", "EXPEDITED", "ONE_DAY", "ECONOMY"].includes(String(s.type)) &&
            object(s.shipToLocationUsedForEstimate) &&
            s.shipToLocationUsedForEstimate.country === "US" &&
            s.shipToLocationUsedForEstimate.postalCode === w.zip,
        )
        .map((s) => money(s.shippingCost))
        .filter((v): v is number => v !== null)
    : [];
  const states = Array.isArray(value.estimatedAvailabilities)
    ? value.estimatedAvailabilities
        .filter(object)
        .filter(
          (a) => Array.isArray(a.deliveryOptions) && a.deliveryOptions.includes("SHIP_TO_HOME"),
        )
        .map((a) => a.estimatedAvailabilityStatus)
    : [];
  const ended = typeof value.itemEndDate === "string" ? Date.parse(value.itemEndDate) : null;
  const availability =
    states.includes("OUT_OF_STOCK") || (ended !== null && Number.isFinite(ended) && ended <= now)
      ? "out-of-stock"
      : states.length > 0 &&
          states.every((s) => s === "IN_STOCK" || s === "LIMITED_STOCK") &&
          (ended === null || Number.isFinite(ended))
        ? "in-stock"
        : "unknown";
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
      feesCents: null,
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
