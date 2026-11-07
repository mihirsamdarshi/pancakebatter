import type { ZodType } from "zod";
import {
  CloudflareClient,
  ruleEmail,
  TokenUnavailable,
  tokenReadable,
  UpstreamError,
  type Policy,
} from "./cloudflare.ts";
import type { Config } from "./config.ts";
import {
  GuestsBodySchema,
  InviteBodySchema,
  LastLoginQuerySchema,
  MAX_BODY_BYTES,
  PublishedBodySchema,
} from "./schemas.ts";

// Writes (PUT /guests and POST /revoke together) allowed in a sliding hour.
// The count is kept in memory: the Deployment runs one replica, and a restart
// starts it from zero.
export const MAX_WRITES_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

export type Logger = (entry: Record<string, unknown>) => void;

export interface HandlerOptions {
  log?: Logger;
  now?: () => number;
}

export interface Handler {
  fetch(request: Request): Promise<Response>;
}

// One JSON line per entry on stdout. Loki scrapes it.
export const stdoutLogger: Logger = (entry) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

function reply(status: number, body: unknown, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}
function refuse(status: number, error: string, message: string, headers?: HeadersInit): Response {
  return reply(status, { error, message }, headers);
}

// Which guests the policy lists, or undefined when the policy is not the
// plain allow-list of single emails this service is willing to edit.
function guestsOf(policy: Policy): string[] | undefined {
  if (policy.decision !== "allow") return undefined;
  const emails: string[] = [];
  for (const rule of policy.include) {
    const email = ruleEmail(rule);
    if (email === undefined) return undefined;
    emails.push(email);
  }
  return emails;
}

export function createHandler(
  upstream: string,
  config: Config,
  options: HandlerOptions = {},
): Handler {
  const log = options.log ?? stdoutLogger;
  const now = options.now ?? Date.now;
  const cloudflare = new CloudflareClient(upstream, config);

  let writing = false;
  let writeTimes: number[] = [];

  // Seconds to wait when the hourly limit is used up, else 0. A taken slot is
  // counted at once, so a Cloudflare error still uses one.
  function takeWriteSlot(): number {
    const t = now();
    writeTimes = writeTimes.filter((time) => t - time < HOUR_MS);
    if (writeTimes.length >= MAX_WRITES_PER_HOUR)
      return Math.ceil((HOUR_MS - (t - (writeTimes[0] as number))) / 1000);
    writeTimes.push(t);
    return 0;
  }

  // Reads and checks the body once. Everything after this uses plain types.
  async function readJson<T>(request: Request, schema: ZodType<T>): Promise<T | Response> {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
      return refuse(415, "unsupported_media_type", "Send application/json.");
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES)
      return refuse(413, "too_large", "The body is too large.");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return refuse(400, "bad_request", "The body is not JSON.");
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      return refuse(
        400,
        "bad_request",
        parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      );
    return parsed.data;
  }

  function failure(error: unknown, what: string): Response {
    if (error instanceof TokenUnavailable) {
      log({ event: "error", what, reason: "token-unavailable" });
      return refuse(503, "token_unavailable", "The Cloudflare token is not available.");
    }
    if (error instanceof UpstreamError) {
      log({
        event: "error",
        what,
        reason: "upstream",
        upstreamStatus: error.status,
        codes: error.codes,
      });
      return refuse(502, "upstream_error", "Cloudflare did not accept the request.");
    }
    throw error;
  }

  // The policy must be the plain allow-list this service edits. Anything else
  // is refused with an alert: someone changed the policy by hand.
  async function loadGuests(
    what: string,
  ): Promise<{ policy: Policy; emails: string[] } | Response> {
    const policy = await cloudflare.getPolicy();
    const emails = guestsOf(policy);
    if (emails === undefined) {
      log({
        event: "alert",
        what,
        reason: "policy-not-a-plain-email-allow-list",
        decision: policy.decision,
      });
      return refuse(
        409,
        "policy_unexpected",
        "The policy is not an allow-list of single emails. Refusing to touch it.",
      );
    }
    return { policy, emails };
  }

  async function getGuests(): Promise<Response> {
    try {
      const loaded = await loadGuests("guests.get");
      if (loaded instanceof Response) return loaded;
      return reply(200, { emails: loaded.emails });
    } catch (error) {
      return failure(error, "guests.get");
    }
  }

  async function putGuests(request: Request): Promise<Response> {
    const body = await readJson(request, GuestsBodySchema);
    if (body instanceof Response) return body;
    if (body.emails.length === 0) {
      log({ event: "refused", what: "guests.put", reason: "last-guest" });
      return refuse(409, "last_guest", "Refusing to write an empty guest list.");
    }
    if (writing) return refuse(409, "write_in_progress", "Another write is running.");
    writing = true;
    try {
      const loaded = await loadGuests("guests.put");
      if (loaded instanceof Response) return loaded;
      const added = body.emails.filter((email) => !loaded.emails.includes(email));
      const removed = loaded.emails.filter((email) => !body.emails.includes(email));
      if (added.length === 0 && removed.length === 0)
        return reply(200, { emails: loaded.emails, changed: false });
      const wait = takeWriteSlot();
      if (wait > 0) {
        log({ event: "refused", what: "guests.put", reason: "rate-limit" });
        return refuse(429, "rate_limited", "Too many writes this hour.", {
          "retry-after": String(wait),
        });
      }
      const audit = {
        event: "audit",
        action: "guests.put",
        added,
        removed,
        count: body.emails.length,
      };
      try {
        const stored = await cloudflare.putPolicy(
          loaded.policy,
          body.emails.map((email) => ({ email: { email } })),
        );
        log({ ...audit, ok: true });
        return reply(200, { emails: guestsOf(stored) ?? body.emails, changed: true });
      } catch (error) {
        log({ ...audit, ok: false });
        throw error;
      }
    } catch (error) {
      return failure(error, "guests.put");
    } finally {
      writing = false;
    }
  }

  // Ends every session of the application, all guests included. Cloudflare has
  // no way to end one user's session for one application.
  async function revoke(): Promise<Response> {
    if (writing) return refuse(409, "write_in_progress", "Another write is running.");
    writing = true;
    try {
      const wait = takeWriteSlot();
      if (wait > 0) {
        log({ event: "refused", what: "revoke", reason: "rate-limit" });
        return refuse(429, "rate_limited", "Too many writes this hour.", {
          "retry-after": String(wait),
        });
      }
      try {
        await cloudflare.revokeTokens();
        log({ event: "audit", action: "revoke", ok: true });
        return reply(200, { revoked: true });
      } catch (error) {
        log({ event: "audit", action: "revoke", ok: false });
        throw error;
      }
    } catch (error) {
      return failure(error, "revoke");
    } finally {
      writing = false;
    }
  }

  async function lastLogin(url: URL): Promise<Response> {
    const query = LastLoginQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success)
      return refuse(
        400,
        "bad_request",
        query.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; "),
      );
    try {
      return reply(200, {
        email: query.data.email,
        lastLogin: await cloudflare.lastLogin(query.data.email),
      });
    } catch (error) {
      return failure(error, "last-login");
    }
  }

  // Notification email (design section F). The routes and their checks exist
  // so the app can be written against them; nothing is sent yet, so a valid
  // request gets 501. The service will write the text and the link itself.
  async function notify(request: Request, kind: "invite" | "published"): Promise<Response> {
    const schema: ZodType = kind === "invite" ? InviteBodySchema : PublishedBodySchema;
    const body = await readJson(request, schema);
    if (body instanceof Response) return body;
    return refuse(501, "not_enabled", "Notification email is not switched on.");
  }

  // Only these routes exist. Anything else is a 404, whatever the method.
  const ROUTES: Record<string, string[]> = {
    "/guests": ["GET", "PUT"],
    "/revoke": ["POST"],
    "/last-login": ["GET"],
    "/notify/invite": ["POST"],
    "/notify/published": ["POST"],
  };

  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        if (request.method !== "GET") return refuse(405, "method_not_allowed", "Use GET.");
        // No call to Cloudflare: the probe must not spend the API quota.
        return tokenReadable(config.tokenFile)
          ? reply(200, { ok: true })
          : refuse(503, "token_unavailable", "The Cloudflare token is not available.");
      }
      // Host discipline, before anything else. Only the Service name works.
      const host = (request.headers.get("host") ?? url.host).toLowerCase();
      if (!config.allowedHosts.includes(host)) return refuse(404, "not_found", "Not found.");
      const methods = ROUTES[url.pathname];
      if (methods === undefined) return refuse(404, "not_found", "Not found.");
      // The only caller is the reports app's server. A browser request (these
      // headers are set by browsers and cannot be removed by a page) is not it.
      if (request.headers.has("origin") || request.headers.has("sec-fetch-site"))
        return refuse(403, "forbidden", "Browser requests are not accepted.");
      if (!methods.includes(request.method))
        return refuse(405, "method_not_allowed", "Method not allowed.", {
          allow: methods.join(", "),
        });
      switch (`${request.method} ${url.pathname}`) {
        case "GET /guests":
          return getGuests();
        case "PUT /guests":
          return putGuests(request);
        case "POST /revoke":
          return revoke();
        case "GET /last-login":
          return lastLogin(url);
        case "POST /notify/invite":
          return notify(request, "invite");
        default:
          return notify(request, "published");
      }
    },
  };
}
