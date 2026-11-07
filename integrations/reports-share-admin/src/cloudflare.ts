import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Config } from "./config.ts";

// The Cloudflare calls this service makes. Checked on 2026-11-07 against the
// published API schema (github.com/cloudflare/api-schemas, openapi.json):
//
//   GET  /accounts/{account_id}/access/policies/{policy_id}
//        access-policies-get-an-access-reusable-policy
//        token groups: Access: Apps and Policies Read or Write
//   PUT  /accounts/{account_id}/access/policies/{policy_id}
//        access-policies-update-an-access-reusable-policy
//        token group: Access: Apps and Policies Write
//        Body: name, decision and include are required. The other fields are
//        optional and a missing one is reset, so the rest is sent back.
//   GET  /accounts/{account_id}/access/apps/{app_id}
//        access-applications-get-an-access-application
//        token groups: Access: Apps and Policies Read or Write
//        Read before each write, to check that the application still uses
//        the policy (its `policies` list holds objects with an `id`).
//   POST /accounts/{account_id}/access/apps/{app_id}/revoke_tokens
//        access-applications-revoke-service-tokens
//        token groups: Access: Apps and Policies Revoke or Write
//        Ends every session of this application, for all users. No body.
//   GET  /accounts/{account_id}/access/logs/access_requests
//        access-authentication-logs-get-access-authentication-logs
//        token group: Access: Audit Logs Read
//        Query used: email, email_exact, emailOp, direction, limit. The schema lists
//        app_uidOp but no app_uid parameter, so the application is filtered
//        here, on each entry's app_uid.
//
// The dashboard calls "Write" "Edit". Docs: developers.cloudflare.com/api
// (Zero Trust, Access, Policies / Applications / Logs).

export const UPSTREAM_TIMEOUT_MS = 15_000;

// Fields of the GET answer that the PUT does not take. Everything else is sent
// back unchanged, including fields this code has never heard of.
const READ_ONLY_FIELDS = ["id", "created_at", "updated_at", "account_id", "app_count", "reusable"];
// Fields the schema marks nullable in the PUT body. A null here is sent back
// as null (dropping it could reset the value and drift from Terraform's
// state). A null in any other field is left out.
const NULLABLE_FIELDS = ["session_duration"];

const ResultEnvelope = z.object({ success: z.literal(true), result: z.unknown() });
// looseObject keeps the fields that are not named here.
const PolicySchema = z.looseObject({ decision: z.string(), include: z.array(z.unknown()) });
const AppSchema = z.looseObject({
  policies: z.array(z.union([z.string(), z.looseObject({ id: z.string() })])).default([]),
});
const AccessLogsSchema = z.array(
  z.looseObject({
    app_uid: z.string().optional(),
    user_email: z.string().optional(),
    allowed: z.boolean().optional(),
    created_at: z.string().optional(),
  }),
);

export type Policy = z.infer<typeof PolicySchema>;

// Failure types for the handler to turn into answers. The messages never
// contain the token or anything Cloudflare sent.
export class TokenUnavailable extends Error {}
export class UpstreamError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly codes: number[],
  ) {
    super("Cloudflare request failed");
  }
}

// Read on every call, so a rotated Secret takes effect without a restart. A
// value with spaces or control characters counts as missing.
function readToken(file: string): string | undefined {
  try {
    const token = readFileSync(file, "utf8").trim();
    return /^[\x21-\x7e]+$/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

export function tokenReadable(file: string): boolean {
  return readToken(file) !== undefined;
}

// An include rule that is exactly { email: { email: "<address>" } }.
export function ruleEmail(rule: unknown): string | undefined {
  if (typeof rule !== "object" || rule === null || Array.isArray(rule)) return undefined;
  const keys = Object.keys(rule);
  const inner = (rule as Record<string, unknown>).email;
  if (keys.length !== 1 || keys[0] !== "email") return undefined;
  if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return undefined;
  const innerKeys = Object.keys(inner);
  const address = (inner as Record<string, unknown>).email;
  if (innerKeys.length !== 1 || innerKeys[0] !== "email" || typeof address !== "string")
    return undefined;
  return address;
}

export class CloudflareClient {
  constructor(
    // Fixed in index.ts. This constant is what keeps the token going to
    // Cloudflare and nowhere else.
    private readonly baseUrl: string,
    private readonly config: Config,
    private readonly timeoutMs: number = UPSTREAM_TIMEOUT_MS,
  ) {}

  private async call(
    method: string,
    path: string,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<unknown> {
    const token = readToken(this.config.tokenFile);
    if (token === undefined) throw new TokenUnavailable("token file missing or unusable");
    const url = new URL(`${this.baseUrl}/accounts/${this.config.accountId}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {}))
      url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        // A redirect would carry the token to another host.
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new UpstreamError(undefined, []);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new UpstreamError(response.status, []);
    }
    const envelope = ResultEnvelope.safeParse(json);
    if (!response.ok || !envelope.success) {
      // Only the numeric error codes are kept, never the text.
      const errors = (json as { errors?: { code?: unknown }[] } | null)?.errors;
      const codes = Array.isArray(errors)
        ? errors.flatMap((e) => (typeof e?.code === "number" ? [e.code] : []))
        : [];
      throw new UpstreamError(response.status, codes);
    }
    return envelope.data.result;
  }

  private policyPath() {
    return `/access/policies/${this.config.policyId}`;
  }

  async getPolicy(): Promise<Policy> {
    const policy = PolicySchema.safeParse(await this.call("GET", this.policyPath()));
    if (!policy.success) throw new UpstreamError(200, []);
    return policy.data;
  }

  // Writes the policy back with only `include` replaced. Returns the policy as
  // Cloudflare stored it.
  async putPolicy(current: Policy, include: unknown[]): Promise<Policy> {
    const body: Record<string, unknown> = { ...current, include };
    for (const field of READ_ONLY_FIELDS) delete body[field];
    for (const [key, value] of Object.entries(body))
      if (value === null && !NULLABLE_FIELDS.includes(key)) delete body[key];
    const stored = PolicySchema.safeParse(await this.call("PUT", this.policyPath(), { body }));
    if (!stored.success) throw new UpstreamError(200, []);
    return stored.data;
  }

  // The IDs of the policies the application uses.
  async appPolicyIds(): Promise<string[]> {
    const app = AppSchema.safeParse(await this.call("GET", `/access/apps/${this.config.appId}`));
    if (!app.success) throw new UpstreamError(200, []);
    return app.data.policies.map((p) => (typeof p === "string" ? p : p.id));
  }

  async revokeTokens(): Promise<void> {
    await this.call("POST", `/access/apps/${this.config.appId}/revoke_tokens`);
  }

  // The newest allowed Access request of this application by this email, as
  // an ISO time, or null. Only the last 100 events of the email are searched.
  async lastLogin(email: string): Promise<string | null> {
    const result = await this.call("GET", "/access/logs/access_requests", {
      query: { email, email_exact: "true", emailOp: "eq", direction: "desc", limit: "100" },
    });
    const entries = AccessLogsSchema.safeParse(result);
    if (!entries.success) throw new UpstreamError(200, []);
    const times = entries.data
      .filter(
        (e) =>
          e.app_uid === this.config.appId &&
          e.user_email?.toLowerCase() === email &&
          e.allowed === true &&
          e.created_at !== undefined,
      )
      .map((e) => e.created_at as string)
      .sort();
    return times.at(-1) ?? null;
  }
}
