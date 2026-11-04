import { createHash } from "node:crypto";
import type { Config } from "./config.ts";
import type { KeyDirectory } from "./keys.ts";
import { NOTIFICATION_ID, type LogReason, type Logger } from "./log.ts";
import { parseSignatureHeader, verifyNotification } from "./signature.ts";
import { STORAGE_DESIGN_VERSION, type BlockReason, type Store } from "./store.ts";

export const MAX_BODY = 16 * 1024;
export const MAX_IN_FLIGHT = 8;
export const RATE_PER_MINUTE = 60;
export const RATE_BURST = 20;
export const TOPIC = "MARKETPLACE_ACCOUNT_DELETION";
const SELFTEST_FAIL_MS = 60 * 60 * 1000;
const CHALLENGE = /^[A-Za-z0-9_-]{1,128}$/;

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

  constructor(
    private readonly config: Config,
    private readonly store: Store | null,
    private readonly initBlock: BlockReason | null,
    private readonly keys: KeyDirectory,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.refilledAt = now();
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
    if (req.method !== "GET") return path === "/state" || path === "/healthz" ? empty(405) : empty(404);
    if (path === "/healthz") return json(200, { ok: true });
    if (path === "/state")
      return json(200, {
        ...this.state(),
        storageDesignVersion: STORAGE_DESIGN_VERSION,
        instanceId: this.store?.instanceId ?? null,
      });
    return empty(404);
  }

  private admit(): boolean {
    const t = this.now();
    this.tokens = Math.min(RATE_BURST, this.tokens + ((t - this.refilledAt) / 60_000) * RATE_PER_MINUTE);
    this.refilledAt = t;
    if (this.tokens < 1 || this.inFlight >= MAX_IN_FLIGHT) return false;
    this.tokens -= 1;
    return true;
  }

  /** The public port. Only the configured path exists; everything else is 404. */
  async handlePublic(req: Incoming): Promise<Outgoing> {
    const path = req.target.split("?")[0];
    if (path !== this.config.endpointPath) return empty(404);
    if (!this.admit()) {
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
      this.log("challenge-rejected", { status: 400, reason: "bad-challenge" });
      return empty(400);
    }
    this.log("challenge", { status: 200, bytes: code.length }); // length only, so the pattern can be checked
    return json(200, { challengeResponse: this.challengeResponse(code) });
  }

  private reject(status: number, reason: LogReason): Outgoing {
    this.log("notification-rejected", { status, reason });
    return status === 503 || status === 413 ? { status, headers: { connection: "close" } } : empty(status);
  }

  private async notification(req: Incoming): Promise<Outgoing> {
    const type = (req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") return this.reject(415, "bad-content-type");
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
    if (lookup.kind === "invalid-kid") return this.reject(412, "unknown-key");
    if (lookup.kind === "unavailable") {
      this.log("key-fetch-failed", { status: 503, reason: lookup.reason });
      return this.reject(503, lookup.reason);
    }
    if (!verifyNotification(lookup.key, parsedHeader.signature, body)) return this.reject(412, "bad-signature");

    let message: unknown;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch {
      return this.reject(400, "bad-json");
    }
    const n = readNotification(message);
    if (n === "wrong-topic") return this.reject(400, "wrong-topic");
    if (!n) return this.reject(400, "bad-schema");

    let result: "new" | "duplicate";
    try {
      result = this.store.record(n, this.now());
    } catch {
      this.log("storage-failed", { status: 503 });
      return { status: 503, headers: { connection: "close" } };
    }
    this.log(result === "new" ? "notification-stored" : "notification-duplicate", { status: 200, id: n.id, bytes: body.length });
    return empty(200);
  }
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const DATE = /^[0-9T:.+\-Z]{10,40}$/;

/**
 * Strict schema. Reads only the notification id, event date and attempt count. `data` (userId,
 * username, eiasToken) must be an object but none of its fields is read, kept or logged.
 */
function readNotification(message: unknown): { id: string; eventDate: string; publishAttemptCount: number } | "wrong-topic" | null {
  if (!object(message) || !object(message.metadata) || !object(message.notification)) return null;
  if (message.metadata.topic !== TOPIC) return "wrong-topic";
  const n = message.notification;
  if (typeof n.notificationId !== "string" || !NOTIFICATION_ID.test(n.notificationId)) return null;
  if (typeof n.eventDate !== "string" || !DATE.test(n.eventDate)) return null;
  const attempt = n.publishAttemptCount;
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 0 || attempt > 1_000_000) return null;
  if (!object(n.data)) return null;
  return { id: n.notificationId, eventDate: n.eventDate, publishAttemptCount: attempt };
}
