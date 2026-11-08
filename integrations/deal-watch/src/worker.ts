import {
  POLICY_VERSION,
  policyIdentity,
  budgets,
  qualify,
  validateWatch,
  type Watch,
  type Binding,
  type Offer,
  type Retailer,
} from "./vendor/domain.ts";
import { EbayClient } from "./ebay.ts";
import { discoveryIds, parseEbay } from "./ebay-adapter.ts";
import { collect, fetchReferences, referenceCodes } from "./adapters.ts";
import { parseBrowserUrl } from "./browser-adapters.ts";
import {
  boundedText,
  invalid,
  nativeFetch,
  UpstreamError,
  type Fetcher,
  type InvalidReason,
} from "./http.ts";
import { readEbayGate, parseEbayStateUrl, auditEbayOffers, type EbayGate } from "./ebay-gate.ts";
import { sendDiscord, message, type Delivery } from "./discord.ts";
interface QueueEvent {
  id: string;
  watch_id: string;
  binding_id: string;
  offer_id: string;
  policy_version: string;
  kind: "alert" | "verify";
  lease_id: string;
  attempts: number;
}
interface AppWatch {
  id: string;
  preferences: { paused: boolean; muted: boolean; purchased: boolean };
}
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/.test(v);
export interface Options {
  baseUrl: string;
  ebay?: EbayClient;
  webhook?: string;
  fetcher?: Fetcher;
  /** Browser service origin for Target and Best Buy; those retailers are unsupported without it. */
  browserUrl?: string;
  /** eBay receiver origin (its internal port). Without it, or unless it says CLEAR, the eBay group is BLOCKED. */
  ebayStateUrl?: string;
  now?: () => number;
  random?: () => number;
  watches: Watch[];
  startupDelay?: boolean;
  allowLocalHttp?: boolean;
}
/**
 * One outcome-only line per attempted retailer check: no ids, prices, URLs or error text. An
 * `invalid-data` outcome may add a fixed `reason` code (see `InvalidReason`); it is never sent to the app.
 */
export function checkLine(
  retailer: Retailer,
  outcome: string,
  ms: number,
  reason?: InvalidReason,
): string {
  return JSON.stringify({ event: "check", retailer, outcome, ...(reason && { reason }), ms });
}
export class Worker {
  readonly policyVersion: string;
  readonly watches: Watch[];
  readonly fetcher: Fetcher;
  readonly now: () => number;
  readonly random: () => number;
  readonly base: URL;
  readonly floor = new Map<Retailer, number>();
  readonly failures = new Map<Retailer, number>();
  readonly cache = new Map<string, Map<string, Offer>>();
  readonly sent = new Map<string, string>();
  readonly cursor = new Map<Retailer, number>();
  readonly references = new Map<string, { cents: number; at: number }>();
  nextReferenceAt = 0;
  nextDelivery = 0;
  lastSuccessfulCycle = 0;
  constructor(readonly options: Options) {
    this.base = new URL(options.baseUrl);
    if (options.browserUrl !== undefined) parseBrowserUrl(options.browserUrl);
    if (options.ebayStateUrl !== undefined) parseEbayStateUrl(options.ebayStateUrl);
    this.fetcher = options.fetcher ?? nativeFetch;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.watches = options.watches;
    this.policyVersion = policyIdentity(this.watches);
    if (
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      this.base.pathname !== "/" ||
      !(
        this.base.protocol === "https:" ||
        (options.allowLocalHttp === true &&
          this.base.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(this.base.hostname))
      )
    )
      throw new Error("App URL must be the fixed HTTPS origin");
    for (const w of this.watches) {
      validateWatch(w);
      for (const b of w.bindings)
        this.floor.set(
          b.retailer,
          this.now() + (options.startupDelay === false ? 0 : budgets[b.retailer]),
        );
    }
  }
  async api(path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await this.fetcher(
      new Request(new URL(path, this.base), {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error("App request failed");
    }
    const data: unknown = JSON.parse(await boundedText(res, 1024 * 1024));
    if (!isObject(data)) throw new Error("Invalid app response");
    return data;
  }
  /** Extra-item reference prices for enabled bindings; one request per 6 hours after success, per 30 minutes otherwise. Never throws. */
  async refreshReferences(): Promise<void> {
    const now = this.now();
    if (now < this.nextReferenceAt) return;
    const ids = [
      ...new Set(
        this.watches.flatMap((w) =>
          w.bindings.filter((b) => b.enabled).flatMap((b) => b.bundleExtraIds ?? []),
        ),
      ),
    ].filter((id) => referenceCodes([id]).length > 0);
    if (ids.length === 0) return;
    let outcome: string;
    try {
      const found = await fetchReferences(ids, this.fetcher);
      for (const [id, cents] of found) this.references.set(id, { cents, at: now });
      outcome = found.size === ids.length ? "ok" : found.size > 0 ? "partial" : "none";
    } catch (error) {
      outcome = error instanceof UpstreamError ? error.code : "invalid-data";
    }
    this.nextReferenceAt = now + (outcome === "ok" ? 21_600_000 : 1_800_000);
    console.log(JSON.stringify({ event: "reference", outcome }));
  }
  /** Section 3.6: null when no eBay binding is enabled (nothing to gate). Fails closed otherwise. */
  async ebayGate(snapshot: Record<string, unknown>): Promise<EbayGate | null> {
    if (!this.watches.some((w) => w.bindings.some((b) => b.retailer === "ebay" && b.enabled)))
      return null;
    const gate = await readEbayGate(this.options.ebayStateUrl, this.fetcher);
    if (gate.state === "CLEAR" && !auditEbayOffers(snapshot))
      return { state: "BLOCKED", reason: "tier1-audit" };
    return gate;
  }
  async runOnce(): Promise<{ checked: number; delivered: number }> {
    const snapshot = await this.api("/api/dashboard");
    const gate = await this.ebayGate(snapshot);
    const ebayBlocked = gate?.state === "BLOCKED";
    if (ebayBlocked) console.log(JSON.stringify({ event: "ebay-blocked", reason: gate.reason }));
    await this.api("/api/integrations/status", {
      policyId: this.policyVersion,
      state: snapshot.policyVersion === this.policyVersion ? "ready" : "policy-mismatch",
      discordConfigured: !!this.options.webhook,
      ...(gate
        ? { ebay: gate.state === "CLEAR" ? { state: "clear" } : { state: "blocked", reason: gate.reason } }
        : {}),
    });
    if (snapshot.policyVersion !== this.policyVersion || !Array.isArray(snapshot.watches))
      throw new Error("Policy mismatch");
    const preferences = new Map<string, AppWatch["preferences"]>();
    for (const row of snapshot.watches) {
      if (!isObject(row) || typeof row.id !== "string" || !isObject(row.preferences)) continue;
      const p = row.preferences;
      if ([p.paused, p.muted, p.purchased].every((v) => typeof v === "boolean"))
        preferences.set(row.id, p as AppWatch["preferences"]);
    }
    let checked = 0,
      delivered = 0;
    const groups = new Map<Retailer, { watch: Watch; binding: Binding }[]>();
    for (const watch of this.watches) {
      const p = preferences.get(watch.id);
      if (!p || p.paused || p.purchased) continue;
      for (const binding of watch.bindings) {
        if (!binding.enabled) continue;
        const list = groups.get(binding.retailer) ?? [];
        list.push({ watch, binding });
        groups.set(binding.retailer, list);
      }
    }
    for (const [retailer, jobs] of groups) {
      // Blocked: skip the whole group before any lease is claimed. Other retailers still run.
      if (retailer === "ebay" && ebayBlocked) continue;
      if ((this.floor.get(retailer) ?? Infinity) > this.now()) continue;
      const start = (this.cursor.get(retailer) ?? 0) % jobs.length;
      for (let n = 0; n < jobs.length; n++) {
        const index = (start + n) % jobs.length,
          { watch, binding } = jobs[index]!;
        const claim = await this.api("/api/checks/claim", {
          watchId: watch.id,
          bindingId: binding.id,
        });
        if (claim.policyVersion !== this.policyVersion) throw new Error("Policy mismatch");
        if (claim.lease === null) continue;
        if (!isObject(claim.lease) || !uuid(claim.lease.leaseId))
          throw new Error("Invalid check lease");
        this.cursor.set(retailer, index + 1);
        // Never let app data shorten our fixed request minimum. Startup also waits a full interval.
        this.floor.set(
          retailer,
          this.now() + budgets[retailer] + Math.floor(this.random() * budgets[retailer] * 0.1),
        );
        let result:
          | { offer: Offer }
          | { offers: Offer[]; mode: "upsert" }
          | { discovery: string[] }
          | { error: string; retryAfterMs: number };
        const key = `${watch.id}/${binding.id}`;
        const task = claim.lease.task;
        const checkStart = Date.now();
        let outcome = "ok";
        let reason: InvalidReason | undefined;
        const itemId =
          isObject(task) &&
          task.kind === "item" &&
          typeof task.itemId === "string" &&
          /^v1\|\d{9,20}\|\d{1,20}$/.test(task.itemId)
            ? task.itemId
            : null;
        try {
          if (retailer === "ebay" && !this.options.ebay) throw new UpstreamError("unsupported");
          if (retailer === "ebay" && !binding.ebayGtin) throw invalid("binding");
          if (retailer === "ebay" && isObject(task) && task.kind === "search") {
            const ids = discoveryIds(
              await this.options.ebay!.searchByGtin(binding.ebayGtin!, watch.zip),
            );
            result = { discovery: ids };
            const cache = this.cache.get(key);
            if (cache) for (const id of cache.keys()) if (!ids.includes(id)) cache.delete(id);
          } else {
            if (retailer === "ebay" && itemId === null) throw invalid("item-id");
            let offer: Offer | null;
            try {
              offer =
                retailer === "ebay"
                  ? parseEbay(
                      await this.options.ebay!.getRestItem(itemId!, watch.zip),
                      watch,
                      binding,
                      itemId!,
                      this.now(),
                    )
                  : await collect(
                      watch,
                      binding,
                      this.fetcher,
                      this.now(),
                      this.references,
                      this.options.browserUrl,
                    );
            } catch (error) {
              // Owner decision 19: a listing whose GTIN is not the watch GTIN is not our product. That is a
              // successful check with nothing to store (an empty offers list), never a failure or a backoff.
              if (
                !(retailer === "ebay" && error instanceof UpstreamError && error.reason === "gtin-mismatch")
              )
                throw error;
              offer = null;
            }
            if (offer === null) {
              result = { offers: [], mode: "upsert" };
              outcome = "not-product";
              reason = "gtin-mismatch";
              this.cache.get(key)?.delete(itemId!);
              this.sent.delete(`${key}/${itemId!}`);
            } else {
              result = retailer === "ebay" ? { offers: [offer], mode: "upsert" } : { offer };
              const cache =
                retailer === "ebay"
                  ? (this.cache.get(key) ?? new Map<string, Offer>())
                  : new Map<string, Offer>();
              cache.set(offer.id, offer);
              while (cache.size > 10) cache.delete(cache.keys().next().value!);
              this.cache.set(key, cache);
              const seen = qualify(watch, binding, offer, this.now());
              if (!seen.eligible && !seen.verify) this.sent.delete(`${key}/${offer.id}`);
            }
          }
          this.failures.set(retailer, 0);
        } catch (error) {
          // An unexpected (non-upstream) exception is labelled internal so a code bug never passes as an eBay data problem.
          const failure =
              error instanceof UpstreamError
                ? error
                : retailer === "ebay"
                  ? invalid("internal")
                  : new UpstreamError("invalid-data"),
            count = Math.min((this.failures.get(retailer) ?? 0) + 1, 12);
          this.failures.set(retailer, count);
          outcome = failure.code;
          reason = failure.reason;
          const delay = Math.max(
            budgets[retailer] * Math.min(2 ** count, 32),
            failure.retryAfterMs,
          );
          this.floor.set(retailer, Math.max(this.floor.get(retailer) ?? 0, this.now() + delay));
          // A detail failure invalidates only that listing. Discovery failure
          // does not disprove cached details or renew their freshness deadline.
          if (retailer === "ebay" && itemId !== null) this.cache.get(key)?.delete(itemId);
          else if (!(retailer === "ebay" && isObject(task) && task.kind === "search"))
            this.cache.delete(key);
          result = { error: failure.code, retryAfterMs: delay };
        }
        console.log(checkLine(retailer, outcome, Date.now() - checkStart, reason));
        // If scheduling/results cannot be persisted, stop this cycle; do not continue upstream work.
        await this.api("/api/checks/complete", {
          watchId: watch.id,
          bindingId: binding.id,
          leaseId: claim.lease.leaseId,
          policyVersion: this.policyVersion,
          ...result,
        });
        checked++;
        // Only after a successful Sony check: a failed one must not be followed by a second request to the same host.
        if (retailer === "sony" && "offer" in result) await this.refreshReferences();
        break;
      }
    }
    if (this.options.webhook && this.nextDelivery <= this.now()) {
      const claim = await this.api("/api/outbox/claim", {});
      if (claim.policyVersion !== this.policyVersion) throw new Error("Policy mismatch");
      if (claim.event !== null) {
        const raw = claim.event;
        if (
          !isObject(raw) ||
          !uuid(raw.id) ||
          !uuid(raw.lease_id) ||
          ![raw.watch_id, raw.binding_id, raw.offer_id, raw.policy_version].every(
            (v) => typeof v === "string",
          ) ||
          (raw.kind !== undefined && raw.kind !== "alert" && raw.kind !== "verify") ||
          typeof raw.attempts !== "number" ||
          !Number.isSafeInteger(raw.attempts) ||
          raw.attempts < 1
        )
          throw new Error("Invalid event lease");
        // A missing kind is an ordinary alert, the stricter of the two checks.
        const event = { ...raw, kind: raw.kind ?? "alert" } as unknown as QueueEvent,
          watch = this.watches.find((w) => w.id === event.watch_id),
          binding = watch?.bindings.find((b) => b.id === event.binding_id),
          key = `${event.watch_id}/${event.binding_id}/${event.offer_id}`;
        const offer = this.cache.get(`${event.watch_id}/${event.binding_id}`)?.get(event.offer_id);
        let result: Delivery;
        if (!watch || !binding?.enabled || event.policy_version !== this.policyVersion)
          result = { status: "suppressed", result: "policy-mismatch", delayMs: 0, messageId: null };
        else if (binding.retailer === "ebay" && ebayBlocked)
          result = {
            status: "retry",
            result: "compliance-blocked",
            delayMs: 3_600_000,
            messageId: null,
          };
        else if (
          !offer ||
          offer.observedAt < this.now() - Math.min(budgets[binding.retailer], 300_000)
        )
          result = {
            status: "retry",
            result: "awaiting-revalidation",
            delayMs: 60_000,
            messageId: null,
          };
        else if (
          offer.id !== event.offer_id ||
          !(event.kind === "verify"
            ? qualify(watch, binding, offer, this.now()).verify
            : qualify(watch, binding, offer, this.now()).eligible)
        )
          result = {
            status: "suppressed",
            result: "no-longer-eligible",
            delayMs: 0,
            messageId: null,
          };
        else {
          const fingerprint = JSON.stringify([
            offer.id,
            offer.condition,
            offer.priceCents,
            offer.shippingCents,
            offer.feesCents,
            offer.shipping,
            event.kind,
          ]);
          if (this.sent.get(key) === fingerprint)
            result = {
              status: "suppressed",
              result: "duplicate-current-offer",
              delayMs: 0,
              messageId: null,
            };
          else {
            result = await sendDiscord(
              this.options.webhook,
              message(watch, binding, offer, event.id, this.now(), event.kind),
              this.fetcher,
            );
            if (result.status === "sent") {
              this.sent.set(key, fingerprint);
              delivered++;
            }
          }
        }
        // A channel throttle applies to every watch, not only this event.
        this.nextDelivery =
          this.now() + Math.max(5_000, result.result === "rate-limited" ? result.delayMs : 0);
        if (result.status === "retry" && result.result !== "rate-limited")
          result.delayMs = Math.max(
            result.delayMs,
            Math.min(3_600_000, 1000 * 2 ** Math.min(event.attempts, 12)),
          );
        await this.api("/api/outbox/complete", {
          id: event.id,
          leaseId: event.lease_id,
          ...result,
        });
      }
    }
    this.lastSuccessfulCycle = this.now();
    return { checked, delivered };
  }
}
