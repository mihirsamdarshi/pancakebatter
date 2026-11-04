import { readFileSync } from "node:fs";
import { qualify, purchaseUrl, type Watch, type Binding, type Offer } from "./vendor/domain.ts";
import { boundedText, retryAfter, nativeFetch, type Fetcher } from "./http.ts";
export interface Delivery {
  status: "sent" | "retry" | "suppressed";
  result:
    | "delivered"
    | "uncertain"
    | "rate-limited"
    | "delivery-failed"
    | "awaiting-revalidation"
    | "no-longer-eligible"
    | "policy-mismatch"
    | "duplicate-current-offer"
    | "compliance-blocked";
  delayMs: number;
  messageId: string | null;
}
export function readWebhook(path: string): string {
  const value = readFileSync(path, "utf8").trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Discord credential file");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "discord.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/api\/webhooks\/\d{1,30}\/[A-Za-z0-9_-]{20,200}$/.test(url.pathname)
  )
    throw new Error("Invalid Discord credential file");
  return value;
}
const clean = (value: string) =>
  value
    .replace(/[\\`*_~[\]()<>@]/g, "")
    .replace(/[\r\n]/g, " ")
    .slice(0, 220);
export function message(
  w: Watch,
  b: Binding,
  o: Offer,
  eventId: string,
  now = Date.now(),
  kind: "alert" | "verify" = "alert",
): string {
  const q = qualify(w, b, o, now);
  if (kind === "verify" ? !q.verify : !q.eligible) throw new Error("Offer no longer qualifies");
  if (!/^[0-9a-f-]{36}$/.test(eventId)) throw new Error("Invalid event identifier");
  const usd = (value: number) => `$${(value / 100).toFixed(2)}`;
  return [
    ...(kind === "verify" ? ["VERIFY AT RETAILER: Sony reports an unclear stock status"] : []),
    `${clean(w.title)} — ${usd(q.totalCents!)} before tax`,
    `${b.retailer === "ebay" ? "eBay listing" : clean(o.seller.name)} · ${o.condition} · shipped to ${w.zip}`,
    `${usd(o.priceCents)} item + ${usd(o.shippingCents!)} shipping + ${usd(o.feesCents!)} mandatory fees`,
    o.shipping === "policy-supported"
      ? "ZIP checkout unverified — nationwide shipping policy only"
      : "Shipping confirmed for the watch destination",
    o.extras.length
      ? `Bundle total is below the verified ${usd(q.referenceCents)} component sum`
      : `Within the ${usd(q.ceilingCents)} price ceiling`,
    purchaseUrl(b, o),
    `Checked ${new Date(o.observedAt).toISOString()} · Event ${eventId}`,
  ].join("\n");
}
export async function sendDiscord(
  webhook: string,
  content: string,
  fetcher: Fetcher = nativeFetch,
): Promise<Delivery> {
  // webhook is read only from the mounted credential file, never from the app/outbox.
  const url = new URL(webhook);
  url.searchParams.set("wait", "true");
  try {
    const res = await fetcher(
      new Request(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: content.slice(0, 2000),
          allowed_mentions: { parse: [] },
          flags: 4,
        }),
      }),
    );
    if (res.status === 429) {
      let delay = retryAfter(res.headers.get("retry-after"));
      try {
        const body = JSON.parse(await boundedText(res, 32768));
        if (typeof body.retry_after === "number" && Number.isFinite(body.retry_after))
          delay = Math.max(delay, body.retry_after * 1000);
      } catch {}
      return {
        status: "retry",
        result: "rate-limited",
        delayMs: Math.min(Math.max(delay, 60_000), 86_400_000),
        messageId: null,
      };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return {
        status: "retry",
        result: res.status >= 500 ? "uncertain" : "delivery-failed",
        delayMs: 60_000,
        messageId: null,
      };
    }
    const ack = JSON.parse(await boundedText(res, 32768));
    if (typeof ack.id !== "string" || !/^\d{1,30}$/.test(ack.id))
      throw new Error("Missing acknowledgement");
    return { status: "sent", result: "delivered", delayMs: 0, messageId: ack.id };
  } catch {
    return { status: "retry", result: "uncertain", delayMs: 60_000, messageId: null };
  }
}
