import { boundedText, nativeFetch, type Fetcher } from "./http.ts";

/** Tier 1, option 1a: the only seller value that may leave the eBay parser. */
export const EBAY_SELLER_LABEL = "eBay seller";
/** Must equal the receiver's STORAGE_DESIGN_VERSION; a mismatch means the Tier 1 invariant is not in force. */
export const EXPECTED_STORAGE_DESIGN_VERSION = "tier1-v1";

export type EbayGate = { state: "CLEAR" } | { state: "BLOCKED"; reason: string };

const REASON = /^[a-z0-9-]{1,40}$/;
const blocked = (reason: string): EbayGate => ({ state: "BLOCKED", reason });

/** An origin like BROWSER_URL (the receiver's internal port); the worker appends /state. */
export function parseEbayStateUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("EBAY_STATE_URL must be an http or https origin");
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
    throw new Error("EBAY_STATE_URL must be an http or https origin");
  return url.origin;
}

/**
 * Reads the receiver's /state. Absent URL, timeout, error, malformed body, a storage design
 * version other than ours, or any state other than CLEAR is BLOCKED. Only a fixed reason code
 * is returned: nothing from the response body is passed on unless it is a short code.
 */
export async function readEbayGate(
  origin: string | undefined,
  fetcher: Fetcher = nativeFetch,
  timeoutMs = 3_000,
): Promise<EbayGate> {
  if (!origin) return blocked("state-url-missing");
  try {
    const res = await fetcher(
      new Request(new URL("/state", origin), {
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );
    if (!res.ok) {
      await res.body?.cancel();
      return blocked("state-unreachable");
    }
    const body: unknown = JSON.parse(await boundedText(res, 4096));
    if (!body || typeof body !== "object" || Array.isArray(body)) return blocked("state-invalid");
    const v = body as Record<string, unknown>;
    if (v.storageDesignVersion !== EXPECTED_STORAGE_DESIGN_VERSION)
      return blocked("storage-version-mismatch");
    if (v.state === "CLEAR") return { state: "CLEAR" };
    return blocked(
      v.state === "BLOCKED" && typeof v.reason === "string" && REASON.test(v.reason)
        ? v.reason
        : "state-invalid",
    );
  } catch {
    return blocked("state-unreachable");
  }
}

const OFFER_KEYS = new Set([
  "id", "productId", "title", "condition", "currency", "priceCents", "shippingCents", "feesCents",
  "shipping", "zip", "availability", "observedAt", "seller", "returns", "warranty", "extras",
]);
const SELLER_KEYS = new Set(["name", "established", "percent", "score"]);

function offerOk(offer: unknown): boolean {
  if (!offer || typeof offer !== "object" || Array.isArray(offer)) return false;
  const o = offer as Record<string, unknown>;
  if (Object.keys(o).some((k) => !OFFER_KEYS.has(k))) return false;
  const s = o.seller;
  if (!s || typeof s !== "object" || Array.isArray(s)) return false;
  const seller = s as Record<string, unknown>;
  return seller.name === EBAY_SELLER_LABEL && Object.keys(seller).every((k) => SELLER_KEYS.has(k));
}

/**
 * Tier 1 audit of what the app serves from /api/dashboard: every eBay offer (current, active and
 * history) must carry the fixed label and only allow-listed keys. It checks structure; it cannot
 * find an unknown username, so it does not prove absence.
 */
export function auditEbayOffers(snapshot: unknown): boolean {
  const watches = (snapshot as { watches?: unknown })?.watches;
  if (!Array.isArray(watches)) return true;
  for (const w of watches) {
    if (!w || typeof w !== "object") continue;
    const row = w as { sources?: unknown; history?: unknown };
    const ebayBindings = new Set<string>();
    for (const s of Array.isArray(row.sources) ? row.sources : []) {
      if (!s || typeof s !== "object" || (s as { retailer?: unknown }).retailer !== "ebay") continue;
      const src = s as { id?: unknown; offer?: unknown; offers?: unknown };
      if (typeof src.id === "string") ebayBindings.add(src.id);
      if (src.offer != null && !offerOk(src.offer)) return false;
      for (const e of Array.isArray(src.offers) ? src.offers : [])
        if (!offerOk((e as { offer?: unknown } | null)?.offer)) return false;
    }
    for (const h of Array.isArray(row.history) ? row.history : []) {
      const entry = h as { binding_id?: unknown; offer?: unknown } | null;
      if (entry && typeof entry.binding_id === "string" && ebayBindings.has(entry.binding_id) && !offerOk(entry.offer))
        return false;
    }
  }
  return true;
}
