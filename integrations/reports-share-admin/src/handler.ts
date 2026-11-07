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
  EmailSchema,
  GuestsBodySchema,
  GuestsPatchSchema,
  MAX_GUESTS,
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

// Reads are answered from memory for a while, so a caller that polls cannot
// use up the Cloudflare API quota.
export const GUESTS_CACHE_MS = 30 * 1000;
export const LAST_LOGIN_CACHE_MS = 5 * 60 * 1000;
const LAST_LOGIN_CACHE_MAX = 100;

export interface HandlerOptions {
  log?: Logger;
  now?: () => number;
  upstreamTimeoutMs?: number; // for tests
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

// The emails of an include list that holds only single-email rules, lower
// cased and without repeats (a dashboard entry may be mixed case or twice), or
// undefined when any rule is something else.
function emailsOf(include: unknown[]): string[] | undefined {
  const emails = new Set<string>();
  for (const rule of include) {
    const email = ruleEmail(rule);
    if (email === undefined) return undefined;
    emails.add(email.toLowerCase());
  }
  return [...emails];
}

// Why this policy is not the plain guest list the service may edit, or
// undefined when it is. The policy must be the one Terraform made: reusable,
// used by one application, with the expected name, decision allow, no exclude
// or require rules, and only single-email include rules.
function policyProblem(policy: Policy, config: Config): string | undefined {
  if (policy.decision !== "allow") return "decision-not-allow";
  if (policy.reusable !== true) return "not-reusable";
  if (policy.app_count !== 1) return "not-used-by-one-app";
  if (policy.name !== config.policyName) return "name-differs";
  for (const rules of [policy.exclude, policy.require])
    if (rules !== undefined && !(Array.isArray(rules) && rules.length === 0))
      return "exclude-or-require-rules";
  if (emailsOf(policy.include) === undefined) return "include-not-plain-emails";
  return undefined;
}

// What a failed call to Cloudflare looks like in the audit line: a failure
// before any answer (timeout, dropped connection) may still have been applied.
function outcome(error: unknown): false | "unknown" {
  return error instanceof UpstreamError && (error.status === undefined || error.status === 200)
    ? "unknown"
    : false;
}

// A last resort for anything unexpected: no stack trace leaves the service.
export function internalError(log: Logger = stdoutLogger): Response {
  log({ event: "error", reason: "internal" });
  return refuse(500, "internal", "Internal error.");
}

// The probe port. /healthz and nothing else, so the probe's reachability
// grants no access to the write routes.
export function createHealthHandler(config: Config): Handler {
  return {
    async fetch(request) {
      if (new URL(request.url).pathname !== "/healthz")
        return refuse(404, "not_found", "Not found.");
      if (request.method !== "GET") return refuse(405, "method_not_allowed", "Use GET.");
      // No call to Cloudflare: the probe must not spend the API quota.
      return tokenReadable(config.tokenFile)
        ? reply(200, { ok: true })
        : refuse(503, "token_unavailable", "The Cloudflare token is not available.");
    },
  };
}

export function createHandler(
  upstream: string,
  config: Config,
  options: HandlerOptions = {},
): Handler {
  const log = options.log ?? stdoutLogger;
  const now = options.now ?? Date.now;
  const cloudflare = new CloudflareClient(upstream, config, options.upstreamTimeoutMs);

  let writing = false;
  let writeTimes: number[] = [];
  let guestsCache: { at: number; emails: string[] } | undefined;
  const lastLoginCache = new Map<string, { at: number; lastLogin: string | null }>();

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
      // 401 and 403 mean the token is expired, revoked or short of a
      // permission: the owner has to act, so it is an alert.
      if (error.status === 401 || error.status === 403) {
        log({
          event: "alert",
          what,
          reason: "token-rejected",
          upstreamStatus: error.status,
          codes: error.codes,
        });
        return refuse(502, "token_rejected", "Cloudflare rejected the token.");
      }
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

  // The policy must be the plain guest list this service edits. Anything else
  // is refused with an alert: someone changed the policy by hand, or the ID
  // points at another policy.
  async function loadGuests(
    what: string,
  ): Promise<{ policy: Policy; emails: string[] } | Response> {
    const policy = await cloudflare.getPolicy();
    const problem = policyProblem(policy, config);
    if (problem !== undefined) return policyUnexpected(what, problem);
    return { policy, emails: emailsOf(policy.include) as string[] };
  }

  function policyUnexpected(what: string, problem: string): Response {
    log({ event: "alert", what, reason: "policy-unexpected", problem });
    return refuse(
      409,
      "policy_unexpected",
      "The policy is not the plain allow-list of single emails. Refusing to touch it.",
    );
  }

  // Whether any address would be refused by EmailSchema, the check every
  // address passes on its way in. One that is not could not be sent back.
  function invalidAddress(emails: string[]): boolean {
    return emails.some((email) => !EmailSchema.safeParse(email).success);
  }

  async function getGuests(request: Request): Promise<Response> {
    // A caller that has just written (or must see the truth) can ask for a
    // fresh read; the answer then refreshes the cache for everyone.
    const fresh = request.headers.get("cache-control")?.toLowerCase().includes("no-cache");
    if (!fresh && guestsCache !== undefined && now() - guestsCache.at < GUESTS_CACHE_MS)
      return reply(200, { emails: guestsCache.emails });
    try {
      const loaded = await loadGuests("guests.get");
      if (loaded instanceof Response) return loaded;
      if (invalidAddress(loaded.emails))
        return policyUnexpected("guests.get", "address-refused-by-schema");
      guestsCache = { at: now(), emails: loaded.emails };
      return reply(200, { emails: loaded.emails });
    } catch (error) {
      return failure(error, "guests.get");
    }
  }

  // The shared end of PUT and PATCH, under the write lock: `loaded` is the
  // live policy and `next` the list to store. Checks the application, takes a
  // write slot, writes, re-reads what was stored, clears the cache and audits.
  async function writeList(
    what: "guests.put" | "guests.patch",
    loaded: { policy: Policy; emails: string[] },
    next: string[],
  ): Promise<Response> {
    const added = next.filter((email) => !loaded.emails.includes(email));
    const removed = loaded.emails.filter((email) => !next.includes(email));
    if (added.length === 0 && removed.length === 0)
      return reply(200, { emails: loaded.emails, changed: false });
    // The application must still use this policy, so the ID in the settings
    // is the guest policy of this application and not another one.
    if (!(await cloudflare.appPolicyIds()).includes(config.policyId)) {
      log({ event: "alert", what, reason: "app-does-not-use-policy" });
      return refuse(409, "policy_unexpected", "The application does not use this policy.");
    }
    const wait = takeWriteSlot();
    if (wait > 0) {
      log({ event: "refused", what, reason: "rate-limit" });
      return refuse(429, "rate_limited", "Too many writes this hour.", {
        "retry-after": String(wait),
      });
    }
    const audit = { event: "audit", action: what, added, removed, count: next.length };
    let stored: Policy;
    try {
      stored = await cloudflare.putPolicy(
        loaded.policy,
        next.map((email) => ({ email: { email } })),
      );
    } catch (error) {
      log({ ...audit, ok: outcome(error) });
      throw error;
    }
    guestsCache = undefined;
    // What Cloudflare stored must be what was asked for.
    const storedEmails = stored.decision === "allow" ? emailsOf(stored.include) : undefined;
    const verified =
      storedEmails !== undefined &&
      storedEmails.length === next.length &&
      next.every((email) => storedEmails.includes(email));
    log({ ...audit, ok: true, verified });
    if (!verified) {
      log({ event: "alert", what, reason: "stored-policy-differs" });
      return refuse(502, "stored_policy_unexpected", "Cloudflare stored something else.");
    }
    return reply(200, { emails: storedEmails, changed: true });
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
      return await writeList("guests.put", loaded, body.emails);
    } catch (error) {
      return failure(error, "guests.put");
    } finally {
      writing = false;
    }
  }

  // A change to the list, not a whole new list: the policy is read live under
  // the lock, so a guest added in the dashboard after the app last looked is
  // kept. Removing someone who is not listed is not an error.
  async function patchGuests(request: Request): Promise<Response> {
    const body = await readJson(request, GuestsPatchSchema);
    if (body instanceof Response) return body;
    if (writing) return refuse(409, "write_in_progress", "Another write is running.");
    writing = true;
    try {
      const loaded = await loadGuests("guests.patch");
      if (loaded instanceof Response) return loaded;
      // An address in the policy that this service would not accept: it
      // cannot be written back, so refuse as GET does.
      if (invalidAddress(loaded.emails))
        return policyUnexpected("guests.patch", "address-refused-by-schema");
      const remove = body.remove ?? [];
      const next = [...loaded.emails.filter((email) => !remove.includes(email))];
      for (const email of body.add ?? []) if (!next.includes(email)) next.push(email);
      if (next.length === 0) {
        log({ event: "refused", what: "guests.patch", reason: "last-guest" });
        return refuse(409, "last_guest", "Refusing to write an empty guest list.");
      }
      if (next.length > MAX_GUESTS) {
        log({ event: "refused", what: "guests.patch", reason: "too-many-guests" });
        return refuse(409, "too_many_guests", `At most ${MAX_GUESTS} guests.`);
      }
      return await writeList("guests.patch", loaded, next);
    } catch (error) {
      return failure(error, "guests.patch");
    } finally {
      writing = false;
    }
  }

  // Asks Cloudflare to end every session of the application, guests included.
  // Cloudflare has no way to end one user's session for one application.
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
        log({ event: "audit", action: "revoke", ok: outcome(error) });
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
    const { email } = query.data;
    const cached = lastLoginCache.get(email);
    if (cached !== undefined && now() - cached.at < LAST_LOGIN_CACHE_MS)
      return reply(200, { email, lastLogin: cached.lastLogin });
    try {
      const found = await cloudflare.lastLogin(email);
      if (lastLoginCache.size >= LAST_LOGIN_CACHE_MAX) lastLoginCache.clear();
      lastLoginCache.set(email, { at: now(), lastLogin: found });
      return reply(200, { email, lastLogin: found });
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
    "/guests": ["GET", "PUT", "PATCH"],
    "/revoke": ["POST"],
    "/last-login": ["GET"],
    "/notify/invite": ["POST"],
    "/notify/published": ["POST"],
  };

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
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
        return getGuests(request);
      case "PUT /guests":
        return putGuests(request);
      case "PATCH /guests":
        return patchGuests(request);
      case "POST /revoke":
        return revoke();
      case "GET /last-login":
        return lastLogin(url);
      case "POST /notify/invite":
        return notify(request, "invite");
      default:
        return notify(request, "published");
    }
  }

  return {
    async fetch(request) {
      try {
        return await route(request);
      } catch {
        // Not the error itself: it could carry request data.
        return internalError(log);
      }
    },
  };
}
