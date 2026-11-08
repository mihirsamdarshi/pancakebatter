export type Fetcher = (request: Request) => Promise<Response>;
/**
 * Closed set of log-safe reasons for an `invalid-data` outcome: one per rejection site, never listing
 * data. A `not-product` outcome also carries one: `gtin-mismatch` or a `gtin-missing:` reason.
 * Only `warnings:` carries numbers, and only eBay's own numeric warning `errorId` values.
 * `gtin-missing:` carries two fixed words only: whether eBay sent a `product` object, and the
 * listing's condition bucket (`other` for a missing or unknown `conditionId`).
 */
export type InvalidReason =
  | "warnings"
  | `warnings:${number}`
  | `warnings:${number},${number}`
  | `warnings:${number},${number},${number}`
  | `warnings:${number},${number},${number},${number}`
  | `warnings:${number},${number},${number},${number},${number}`
  | "internal"
  | "errors"
  | "schema"
  | "size"
  | "encoding"
  | "json"
  | "token"
  | "binding"
  | "item-id"
  | "gtin-mismatch"
  | `gtin-missing:${"no-product" | "no-gtins"}:${"new" | "open-box" | "refurbished" | "other"}`
  | "condition"
  | "buying-option"
  | "price"
  | "currency"
  | "title";
export class UpstreamError extends Error {
  constructor(
    readonly code: "network" | "throttled" | "access-denied" | "invalid-data" | "unsupported",
    readonly retryAfterMs = 0,
    readonly reason?: InvalidReason,
  ) {
    super(code);
  }
}
export const invalid = (reason: InvalidReason) => new UpstreamError("invalid-data", 0, reason);
export async function boundedText(response: Response, maxBytes = 4 * 1024 * 1024): Promise<string> {
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body?.cancel();
    throw invalid("size");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw invalid("size");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid("encoding");
  }
}
export function retryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value),
    delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.min(Math.max(delay, 0), 86_400_000) : 0;
}
export const nativeFetch: Fetcher = (request) => fetch(request);
export async function getPublic(url: string, fetcher: Fetcher = nativeFetch): Promise<string> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !["api.direct.playstation.com", "www.costco.com"].includes(parsed.hostname)
  )
    throw new UpstreamError("unsupported");
  try {
    const res = await fetcher(
      new Request(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: "application/json,text/html",
          "user-agent": "DealWatch/0.1 (personal shopping monitor)",
        },
      }),
    );
    if (res.status === 429) {
      await res.body?.cancel();
      throw new UpstreamError("throttled", retryAfter(res.headers.get("retry-after")));
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw new UpstreamError("access-denied");
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new UpstreamError("network");
    }
    return await boundedText(res);
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError("network");
  }
}
