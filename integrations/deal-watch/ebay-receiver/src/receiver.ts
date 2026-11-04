import { createHash } from "node:crypto";
import type { Config } from "./config.ts";
import type { KeyDirectory } from "./keys.ts";
import type { LogReason, Logger } from "./log.ts";
import { parseSignatureHeader, verifyNotification } from "./signature.ts";
import { Metrics, type NotificationOutcome } from "./metrics.ts";
import { STORAGE_DESIGN_VERSION, type BlockReason, type Store } from "./store.ts";

export const MAX_BODY = 16 * 1024;
export const MAX_IN_FLIGHT = 8;
export const RATE_PER_MINUTE = 60;
export const RATE_BURST = 20;
export const TOPIC = "MARKETPLACE_ACCOUNT_DELETION";
const SELFTEST_FAIL_MS = 60 * 60 * 1000;
// Only hashed, never reflected, so a length cap and no control characters suffice.
const CHALLENGE = /^[^\x00-\x1f\x7f]{1,256}$/;
const SAFE_TEXT = /^[^\x00-\x1f\x7f]+$/;

/** What the HTTP glue gives the handler. The handler never sees a socket or a Host header. */
export interface Incoming {
  method: string;
  /** Request target: path and query only. */
  target: string;
  header(name: string): string | undefined;
  readBody(max: number): Promise<Buffer | "too-large" | "timeout">;
}
export interface Outgoing {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

const empty = (status: number): Outgoing => ({ status });
const json = (status: number, value: unknown): Outgoing => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

export type State =
  | { state: "CLEAR" }
  | { state: "BLOCKED"; reason: BlockReason | "unprocessed" | "key-unavailable" | "selftest-failed" };

export class Receiver {
  private inFlight = 0;
  private tokens = RATE_BURST;
  private refilledAt: number;
  private selfTestFailingSince: number | undefined;
  readonly metrics: Metrics;

  constructor(
    private readonly config: Config,
    private readonly store: Store | null,
    private readonly initBlock: BlockReason | null,
    private readonly keys: KeyDirectory,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.refilledAt = now();
    this.metrics = new Metrics(Math.floor(now() / 1000));
  }

  /** SHA-256 hex of challengeCode + verificationToken + endpoint, the endpoint from configuration. */
  challengeResponse(code: string): string {
    return createHash("sha256")
      .update(code, "utf8")
      .update(this.config.verificationToken, "utf8")
      .update(this.config.endpoint, "utf8")
      .digest("hex");
  }

  noteSelfTest(ok: boolean): void {
    this.metrics.noteSelfTest(ok, Math.floor(this.now() / 1000));
    if (ok) this.selfTestFailingSince = undefined;
    else this.selfTestFailingSince ??= this.now();
  }

  state(): State {
    if (this.initBlock) return { state: "BLOCKED", reason: this.initBlock };
    try {
      if (this.store && this.store.staleCount(this.now()) > 0) return { state: "BLOCKED", reason: "unprocessed" };
    } catch {
      return { state: "BLOCKED", reason: "db-unreadable" };
    }
    if (!this.keys.healthy()) return { state: "BLOCKED", reason: "key-unavailable" };
    if (this.selfTestFailingSince !== undefined && this.now() - this.selfTestFailingSince > SELFTEST_FAIL_MS)
      return { state: "BLOCKED", reason: "selftest-failed" };
    return { state: "CLEAR" };
  }

  /** The internal port: /state for the worker and /healthz for the kubelet. Everything else 404. */
  async handleInternal(req: Incoming): Promise<Outgoing> {
    const path = req.target.split("?")[0];
    if (req.method !== "GET") return path === "/state" || path === "/healthz" || path === "/metrics" ? empty(405) : empty(404);
    if (path === "/healthz") return json(200, { ok: true });
    if (path === "/state")
      return json(200, {
        ...this.state(),
        storageDesignVersion: STORAGE_DESIGN_VERSION,
        instanceId: this.store?.instanceId ?? null,
      });
    if (path === "/metrics") {
      const state = this.state();
      return {
        status: 200,
        headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
        body: this.metrics.render({
          stateReason: state.state === "CLEAR" ? "clear" : state.reason,
          selfTestEnabled: this.config.selfTest,
          storageDesignVersion: STORAGE_DESIGN_VERSION,
        }),
      };
    }
    return empty(404);
  }

  private admit(): boolean {
    const t = this.now();
    this.tokens = Math.min(RATE_BURST, this.tokens + ((t - this.refilledAt) / 60_000) * RATE_PER_MINUTE);
    this.refilledAt = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** The public port. Only the configured path exists; everything else is 404. */
  async handlePublic(req: Incoming): Promise<Outgoing> {
    const path = req.target.split("?")[0];
    if (path !== this.config.endpointPath) return empty(404);
    // The token bucket applies to challenge GETs only. A POST is never refused by a bucket, so a
    // flood of unauthenticated GETs or bad POSTs cannot cause a 429 for a real notification. POSTs
    // are bounded by the in-flight cap, the connection cap and the key-lookup budget.
    if (this.inFlight >= MAX_IN_FLIGHT || (req.method === "GET" && !this.admit())) {
      this.metrics.overloaded++;
      this.log("overloaded", { status: 429 });
      return { status: 429, headers: { "retry-after": "5" } };
    }
    this.inFlight++;
    try {
      const out =
        req.method === "GET"
          ? this.challenge(req)
          : req.method === "POST"
            ? await this.notification(req)
            : ({ status: 405, headers: { allow: "GET, POST" } } satisfies Outgoing);
      if (req.method !== "GET" && req.method !== "POST") this.metrics.notifications.rejected_other++;
      if (req.method !== "GET" && req.method !== "POST") this.log("notification-rejected", { status: 405, reason: "bad-method" });
      return out;
    } catch {
      // Fixed event only. The exception text can hold request data.
      this.log("internal-error", { status: 500 });
      return empty(500);
    } finally {
      this.inFlight--;
    }
  }

  private challenge(req: Incoming): Outgoing {
    const query = req.target.includes("?") ? req.target.slice(req.target.indexOf("?") + 1) : "";
    const params = new URLSearchParams(query);
    const all = params.getAll("challenge_code");
    const code = all[0];
    if (all.length !== 1 || code === undefined || !CHALLENGE.test(code)) {
      this.metrics.challenges.rejected++;
      this.log("challenge-rejected", { status: 400, reason: "bad-challenge" });
      return empty(400);
    }
    this.metrics.challenges.ok++;
    this.log("challenge", { status: 200, bytes: code.length }); // length only, so the pattern can be checked
    return json(200, { challengeResponse: this.challengeResponse(code) });
  }

  private reject(status: number, reason: LogReason): Outgoing {
    this.metrics.notifications[outcomeOf(reason)]++;
    this.log("notification-rejected", { status, reason });
    return status === 503 || status === 413 ? { status, headers: { connection: "close" } } : empty(status);
  }

  private async notification(req: Incoming): Promise<Outgoing> {
    // Content type is not checked: a body that parses and carries a valid signature is accepted.
    const declared = Number(req.header("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BODY) return this.reject(413, "too-large");
    const signatureHeader = req.header("x-ebay-signature");
    if (!signatureHeader) return this.reject(412, "no-signature");
    const parsedHeader = parseSignatureHeader(signatureHeader);
    if (!parsedHeader) return this.reject(412, "bad-signature-header");
    const body = await req.readBody(MAX_BODY);
    if (body === "too-large") return this.reject(413, "too-large");
    if (body === "timeout") return this.reject(408, "body-timeout");

    // No database, no acknowledgement (volume lost or unreadable): eBay must retry.
    if (!this.store) return this.reject(503, this.initBlock ?? "db-unreadable");

    const lookup = await this.keys.lookup(parsedHeader.kid);
    this.metrics.keyLookups[
      lookup.kind === "key" ? "ok" : lookup.kind === "invalid-kid" ? "invalid" : lookup.reason === "key-budget" ? "budget" : "failed"
    ]++;
    if (lookup.kind === "invalid-kid") return this.reject(412, "unknown-key");
    if (lookup.kind === "unavailable") {
      this.log("key-fetch-failed", { status: 503, reason: lookup.reason });
      return this.reject(503, lookup.reason);
    }
    if (!verifyNotification(lookup.key, parsedHeader.signature, body)) return this.reject(412, "bad-signature");

    // Verified from here on: acknowledge with 200 whatever the shape, so eBay never retries a
    // genuine message toward the 24-hour mark-down. Only a fixed reason code is logged.
    let message: unknown;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch {
      message = undefined;
    }
    const n = readNotification(message, body);
    if (n.reason) this.metrics.oddAccepted++;
    if (n.reason) this.log("notification-accepted-odd", { status: 200, reason: n.reason });

    let result: "new" | "duplicate";
    try {
      result = this.store.record(n.record, this.now());
    } catch {
      this.metrics.notifications.storage_failed++;
      this.log("storage-failed", { status: 503 });
      return { status: 503, headers: { connection: "close" } };
    }
    this.metrics.notifications[result === "new" ? "stored" : "duplicate"]++;
    this.log(result === "new" ? "notification-stored" : "notification-duplicate", { status: 200, id: n.record.id, bytes: body.length });
    return empty(200);
  }
}

function outcomeOf(reason: LogReason): NotificationOutcome {
  switch (reason) {
    case "bad-signature":
      return "bad_signature";
    case "unknown-key":
      return "unknown_key";
    case "key-unavailable":
    case "key-budget":
    case "mint-failed":
      return "key_unavailable";
    case "volume-reset":
    case "db-unreadable":
      return "storage_failed";
    default:
      return "rejected_other";
  }
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Lenient read of a VERIFIED message. Reads only the notification id, event date and attempt
 * count; `data` (userId, username, eiasToken) is never read, kept or logged. A missing or odd id
 * falls back to a hash of the verified body, so the row still exists and duplicates still match.
 */
function readNotification(
  message: unknown,
  body: Buffer,
): { record: { id: string; eventDate: string; publishAttemptCount: number }; reason?: LogReason } {
  const root = object(message) ? message : {};
  const meta = object(root.metadata) ? root.metadata : {};
  const n = object(root.notification) ? root.notification : {};
  let reason: LogReason | undefined;
  if (meta.topic !== TOPIC) reason = "wrong-topic";
  const raw = n.notificationId;
  let id: string;
  if (typeof raw === "string" && raw.length <= 200 && SAFE_TEXT.test(raw)) id = raw;
  else {
    id = "body-" + createHash("sha256").update(body).digest("hex");
    reason ??= "bad-schema";
  }
  const eventDate = typeof n.eventDate === "string" && n.eventDate.length <= 40 && SAFE_TEXT.test(n.eventDate) ? n.eventDate : "";
  const attempt = n.publishAttemptCount;
  const publishAttemptCount = typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : 0;
  return { record: { id, eventDate, publishAttemptCount }, reason };
}
