import type { Credentials } from "./config.ts";
import { parsePublicKey, UUID, type PublicKey } from "./signature.ts";

export type Fetcher = (request: Request) => Promise<Response>;

export type Lookup =
  | { kind: "key"; key: PublicKey }
  | { kind: "invalid-kid" }
  | { kind: "unavailable"; reason: "key-unavailable" | "key-budget" | "mint-failed" };

const HOUR = 3_600_000;
const FIVE_MIN = 300_000;
export const KEY_TTL = HOUR;
export const NEGATIVE_TTL = FIVE_MIN;
export const MAX_LOOKUPS_PER_HOUR = 6;
/** Under the 5-second handler budget (design 3.3). */
export const LOOKUP_TIMEOUT_MS = 4000;

class MintFailed extends Error {}

const MAX_BODY = 64 * 1024;

async function boundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_BODY) throw new Error();
  return JSON.parse(text);
}

/**
 * Application token plus getPublicKey. Kept separate from the worker's EbayClient on purpose: this
 * image is built from its own folder and the receiver needs two calls, not Browse. The token logic
 * mirrors the worker's: at most one mint a minute, response shape checked, nothing logged.
 */
export class KeyDirectory {
  private cache = new Map<string, { value: PublicKey; expires: number }>();
  private negative = new Map<string, { kind: "invalid-kid" | "unavailable"; until: number }>();
  private inflight = new Map<string, Promise<Lookup>>();
  private fetchTimes: number[] = [];
  private token: { value: string; expires: number } | undefined;
  private minting: Promise<string> | undefined;
  private nextMint = 0;
  private failing = false;

  constructor(
    private readonly credentials: Credentials,
    private readonly apiBase: string,
    private readonly fetcher: Fetcher = (r) => fetch(r),
    private readonly now: () => number = Date.now,
  ) {}

  /** False while the last mint or key fetch failed and no unexpired cached key exists. */
  healthy(): boolean {
    if (!this.failing) return true;
    const t = this.now();
    for (const entry of this.cache.values()) if (entry.expires > t) return true;
    return false;
  }

  /** Mint-only probe for the recovery loop: proves the keyset works without needing a notification. */
  async probe(): Promise<boolean> {
    try {
      await this.accessToken(AbortSignal.timeout(LOOKUP_TIMEOUT_MS));
      return true;
    } catch {
      return false;
    }
  }

  private async mint(signal: AbortSignal): Promise<string> {
    const t = this.now();
    if (t < this.nextMint) throw new MintFailed();
    this.nextMint = t + 60_000; // at most one mint a minute, even after a failure
    let value: unknown;
    try {
      const response = await this.fetcher(
        new Request(this.apiBase + "/identity/v1/oauth2/token", {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            authorization:
              "Basic " + Buffer.from(this.credentials.clientId + ":" + this.credentials.clientSecret).toString("base64"),
          },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            scope: "https://api.ebay.com/oauth/api_scope",
          }),
        }),
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new MintFailed();
      }
      value = await boundedJson(response);
    } catch {
      throw new MintFailed();
    }
    const v = value as Record<string, unknown> | null;
    if (
      !v ||
      typeof v.access_token !== "string" ||
      !v.access_token.length ||
      v.access_token.length > 16384 ||
      /[\s\x00-\x1f\x7f]/.test(v.access_token) ||
      typeof v.expires_in !== "number" ||
      !Number.isSafeInteger(v.expires_in) ||
      v.expires_in < 120 ||
      v.expires_in > 86400
    )
      throw new MintFailed();
    this.token = { value: v.access_token, expires: this.now() + v.expires_in * 1000 - 60_000 };
    return v.access_token;
  }

  private accessToken(signal: AbortSignal): Promise<string> {
    if (this.token && this.token.expires > this.now()) return Promise.resolve(this.token.value);
    if (!this.minting)
      this.minting = this.mint(signal)
        .then((t) => {
          this.failing = false;
          return t;
        })
        .catch((e) => {
          this.failing = true;
          throw e;
        })
        .finally(() => {
          this.minting = undefined;
        });
    return this.minting;
  }

  async lookup(kid: string): Promise<Lookup> {
    if (!UUID.test(kid)) return { kind: "invalid-kid" };
    const t = this.now();
    const hit = this.cache.get(kid);
    if (hit && hit.expires > t) return { kind: "key", key: hit.value };
    const neg = this.negative.get(kid);
    if (neg && neg.until > t)
      return neg.kind === "invalid-kid" ? { kind: "invalid-kid" } : { kind: "unavailable", reason: "key-unavailable" };
    const pending = this.inflight.get(kid);
    if (pending) return pending;
    this.fetchTimes = this.fetchTimes.filter((x) => x > t - HOUR);
    if (this.fetchTimes.length >= MAX_LOOKUPS_PER_HOUR) return { kind: "unavailable", reason: "key-budget" };
    this.fetchTimes.push(t);
    const run = this.fetchKey(kid).finally(() => this.inflight.delete(kid));
    this.inflight.set(kid, run);
    return run;
  }

  private async fetchKey(kid: string): Promise<Lookup> {
    const signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
    const unavailable = (reason: "key-unavailable" | "mint-failed"): Lookup => {
      this.failing = true;
      this.negative.set(kid, { kind: "unavailable", until: this.now() + NEGATIVE_TTL });
      return { kind: "unavailable", reason };
    };
    let token: string;
    try {
      token = await this.accessToken(signal);
    } catch {
      return unavailable("mint-failed");
    }
    try {
      const response = await this.fetcher(
        new Request(this.apiBase + "/commerce/notification/v1/public_key/" + kid, {
          redirect: "error",
          signal,
          headers: { accept: "application/json", authorization: "Bearer " + token },
        }),
      );
      if (response.status === 404) {
        await response.body?.cancel();
        // A 404 means the key id is wrong; the token worked. Not an outage.
        this.failing = false;
        this.negative.set(kid, { kind: "invalid-kid", until: this.now() + NEGATIVE_TTL });
        return { kind: "invalid-kid" };
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) this.token = undefined;
        return unavailable("key-unavailable");
      }
      const parsed = parsePublicKey(await boundedJson(response));
      if (!parsed) return unavailable("key-unavailable");
      this.failing = false;
      this.cache.set(kid, { value: parsed, expires: this.now() + KEY_TTL });
      return { kind: "key", key: parsed };
    } catch {
      return unavailable("key-unavailable");
    }
  }
}
