import { readFileSync } from "node:fs";
import {
  boundedText,
  invalid,
  nativeFetch,
  retryAfter,
  UpstreamError,
  type Fetcher,
} from "./http.ts";
export interface EbayCredentials {
  clientId: string;
  clientSecret: string;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function parseEbayCredentials(body: string): EbayCredentials {
  try {
    if (Buffer.byteLength(body) > 16384) throw Error();
    const value: unknown = JSON.parse(body);
    if (
      !object(value) ||
      Object.keys(value).some((k) => !["clientId", "clientSecret"].includes(k))
    )
      throw Error();
    for (const key of ["clientId", "clientSecret"])
      if (
        typeof value[key] !== "string" ||
        !value[key].length ||
        value[key].length > 4096 ||
        /[\s\x00-\x1f\x7f:]/.test(value[key])
      )
        throw Error();
    return value as unknown as EbayCredentials;
  } catch {
    throw new Error("Invalid or missing eBay credential file");
  }
}
export function readEbayCredentials(path: string): EbayCredentials {
  try {
    return parseEbayCredentials(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Invalid or missing eBay credential file");
  }
}
class InvalidEbayToken extends UpstreamError {
  constructor() {
    super("access-denied");
  }
}
/** Production Browse only. Tokens remain in memory and never enter observations or logs. */
export class EbayClient {
  private token: { value: string; expires: number } | undefined;
  private minting: Promise<string> | undefined;
  private nextMint = 0;
  constructor(
    private readonly credentials: EbayCredentials,
    private readonly fetcher: Fetcher = nativeFetch,
    private readonly now: () => number = Date.now,
  ) {}
  private async request(path: string, init: RequestInit): Promise<string> {
    try {
      const response = await this.fetcher(
        new Request("https://api.ebay.com" + path, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        }),
      );
      if (!response.ok) {
        if (response.status === 401 && path.startsWith("/buy/browse/")) {
          let invalid = false;
          try {
            const body: unknown = JSON.parse(
              await boundedText(response, 16384),
            );
            invalid =
              object(body) &&
              Array.isArray(body.errors) &&
              body.errors.some(
                (e) => object(e) && e.errorId === 1001 && e.domain === "OAuth",
              );
          } catch {}
          if (invalid) throw new InvalidEbayToken();
          throw new UpstreamError("access-denied");
        }
        await response.body?.cancel();
        if (response.status === 429) {
          const delay = retryAfter(
            response.headers.get("retry-after"),
            this.now(),
          );
          if (path === "/identity/v1/oauth2/token")
            this.nextMint = Math.max(this.nextMint, this.now() + delay);
          throw new UpstreamError("throttled", delay);
        }
        throw new UpstreamError(
          response.status === 401 || response.status === 403
            ? "access-denied"
            : "network",
        );
      }
      return await boundedText(response, 1024 * 1024);
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError("network");
    }
  }
  private async mint(): Promise<string> {
    if (this.now() < this.nextMint)
      throw new UpstreamError("throttled", this.nextMint - this.now());
    // At most one mint/minute even after denied credentials or a lost response.
    this.nextMint = this.now() + 60000;
    const body = await this.request("/identity/v1/oauth2/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization:
          "Basic " +
          Buffer.from(
            this.credentials.clientId + ":" + this.credentials.clientSecret,
          ).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "https://api.ebay.com/oauth/api_scope",
      }),
    });
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      throw invalid("token");
    }
    if (
      !object(value) ||
      typeof value.access_token !== "string" ||
      value.access_token.length < 1 ||
      value.access_token.length > 16384 ||
      /[\s\x00-\x1f\x7f]/.test(value.access_token) ||
      typeof value.expires_in !== "number" ||
      !Number.isSafeInteger(value.expires_in) ||
      value.expires_in < 120 ||
      value.expires_in > 86400 ||
      value.token_type !== "Application Access Token"
    )
      throw invalid("token");
    this.token = {
      value: value.access_token,
      expires: this.now() + value.expires_in * 1000 - 60000,
    };
    return value.access_token;
  }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > this.now()) return this.token.value;
    if (!this.minting)
      this.minting = this.mint().finally(() => {
        this.minting = undefined;
      });
    return this.minting;
  }
  private async browse(path: string, zip: string): Promise<unknown> {
    if (!/^\d{5}$/.test(zip)) throw invalid("binding");
    const token = await this.accessToken();
    let body: string;
    try {
      body = await this.request(path, {
        headers: {
          accept: "application/json",
          authorization: "Bearer " + token,
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
          "X-EBAY-C-ENDUSERCTX":
            "contextualLocation=" + encodeURIComponent("country=US,zip=" + zip),
        },
      });
    } catch (error) {
      if (error instanceof InvalidEbayToken && this.token?.value === token)
        this.token = undefined;
      throw error;
    }
    try {
      return JSON.parse(body);
    } catch {
      throw invalid("json");
    }
  }
  getItem(legacyItemId: string, zip: string): Promise<unknown> {
    if (!/^\d{9,20}$/.test(legacyItemId))
      throw invalid("item-id");
    return this.browse(
      "/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=" +
        legacyItemId +
        "&quantity_for_shipping_estimate=1",
      zip,
    );
  }
  getRestItem(itemId: string, zip: string): Promise<unknown> {
    if (!/^v1\|\d{9,20}\|\d{1,20}$/.test(itemId))
      throw invalid("item-id");
    return this.browse(
      "/buy/browse/v1/item/" +
        encodeURIComponent(itemId) +
        "?quantity_for_shipping_estimate=1",
      zip,
    );
  }
  searchByGtin(gtin: string, zip: string): Promise<unknown> {
    if (!/^\d{8,14}$/.test(gtin)) throw invalid("binding");
    const params = new URLSearchParams({
      gtin,
      limit: "10",
      sort: "price",
      filter:
        "buyingOptions:{FIXED_PRICE},itemLocationCountry:US,conditionIds:{1000|1500|2000|2010|2020|2030|2500}",
    });
    return this.browse("/buy/browse/v1/item_summary/search?" + params, zip);
  }
}
