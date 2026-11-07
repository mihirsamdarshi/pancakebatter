import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { join } from "node:path";
import { configFromEnv, type Config } from "./config.ts";
import {
  createHandler,
  createHealthHandler,
  GUESTS_CACHE_MS,
  internalError,
  LAST_LOGIN_CACHE_MS,
  MAX_WRITES_PER_HOUR,
  type Handler,
} from "./handler.ts";
import { MAX_BODY_BYTES } from "./schemas.ts";

// Dummy values only. None of them is a real ID or token.
const ACCOUNT = "a".repeat(32);
const POLICY = "b".repeat(32);
const APP = "11111111-2222-3333-4444-555555555555";
const OTHER_APP = "99999999-2222-3333-4444-555555555555";
const TOKEN_A = "test-token-A-not-real";
const TOKEN_B = "test-token-B-not-real";
const HOST = "share-admin.test:8080";

const dir = mkdtempSync(join(tmpdir(), "share-admin-"));
const tokenFile = join(dir, "cloudflare-token");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A policy as Cloudflare returns it: read-only fields, fields the service
// never touches, and one it has never heard of.
function freshPolicy() {
  return {
    id: POLICY,
    account_id: ACCOUNT,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-02T00:00:00Z",
    app_count: 1,
    reusable: true,
    name: "reports-share guests",
    decision: "allow",
    include: [{ email: { email: "one@example.test" } }, { email: { email: "two@example.test" } }],
    exclude: [],
    require: [],
    session_duration: "24h",
    approval_required: false,
    purpose_justification_required: false,
    mfa_config: { allowed_authenticators: ["totp"], mfa_disabled: false },
    some_future_field: { nested: [1, 2, 3] },
  } as Record<string, unknown>;
}

interface Seen {
  method: string;
  path: string;
  search: string;
  auth: string | null;
  body: unknown;
}
let seen: Seen[] = [];
let policy = freshPolicy();
let accessLogs: unknown[] = [];
let putGate: Promise<void> | undefined;
let failNext: number | undefined;
let failOn = "GET";
let appPolicies: unknown[] = [{ id: POLICY }];

const READ_ONLY = ["id", "created_at", "updated_at", "account_id", "app_count", "reusable"];

// The fake Cloudflare. It checks the bearer token like the real one and keeps
// one policy in memory.
const fake = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    const text = await request.text();
    seen.push({
      method: request.method,
      path: url.pathname,
      search: url.search,
      auth: request.headers.get("authorization"),
      body: text ? JSON.parse(text) : undefined,
    });
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${currentToken}`)
      // Echoes the credential it was given, as a careless API might.
      return Response.json(
        { success: false, errors: [{ code: 10000, message: `bad credential ${auth}` }] },
        { status: 403 },
      );
    if (failNext !== undefined && request.method === failOn) {
      const status = failNext;
      failNext = undefined;
      return Response.json(
        { success: false, errors: [{ code: 1234, message: `oops ${auth}` }] },
        { status },
      );
    }
    const base = `/accounts/${ACCOUNT}/access`;
    if (url.pathname === `${base}/policies/${POLICY}`) {
      if (request.method === "GET") return Response.json({ success: true, result: policy });
      if (request.method === "PUT") {
        await putGate;
        const body = JSON.parse(text) as Record<string, unknown>;
        // The real PUT resets every field that is not sent.
        policy = { id: POLICY, account_id: ACCOUNT, app_count: 1, reusable: true, ...body };
        return Response.json({ success: true, result: policy });
      }
    }
    if (url.pathname === `${base}/apps/${APP}` && request.method === "GET")
      return Response.json({ success: true, result: { id: APP, policies: appPolicies } });
    if (url.pathname === `${base}/apps/${APP}/revoke_tokens` && request.method === "POST")
      return Response.json({ success: true, result: {} });
    if (url.pathname === `${base}/logs/access_requests`)
      return Response.json({ success: true, result: accessLogs });
    return Response.json({ success: false, errors: [{ code: 7003 }] }, { status: 404 });
  },
});
const upstream = `http://127.0.0.1:${fake.port}`;
afterAll(() => fake.stop(true));

let currentToken = TOKEN_A;
let logs: Record<string, unknown>[] = [];
let clock = 1_000_000;
let config: Config;
let handler: Handler;

beforeEach(() => {
  seen = [];
  policy = freshPolicy();
  accessLogs = [];
  putGate = undefined;
  failNext = undefined;
  failOn = "GET";
  appPolicies = [{ id: POLICY }];
  currentToken = TOKEN_A;
  writeFileSync(tokenFile, `${TOKEN_A}\n`);
  logs = [];
  clock = 1_000_000;
  config = configFromEnv({
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    ACCESS_POLICY_ID: POLICY,
    ACCESS_APP_ID: APP,
    CLOUDFLARE_TOKEN_FILE: tokenFile,
    ALLOWED_HOSTS: HOST,
  });
  handler = createHandler(upstream, config, { log: (e) => logs.push(e), now: () => clock });
});

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return handler.fetch(
    new Request(`http://${HOST}${path}`, {
      method,
      headers: {
        host: HOST,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
const put = (emails: unknown) => call("PUT", "/guests", { emails });
const writes = () => seen.filter((s) => s.method === "PUT" || s.path.endsWith("/revoke_tokens"));
const emailsOf = (rules: unknown) =>
  (rules as { email: { email: string } }[]).map((r) => r.email.email);

describe("config", () => {
  test("refuses a missing or odd ID", () => {
    expect(() => configFromEnv({})).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    expect(() =>
      configFromEnv({
        CLOUDFLARE_ACCOUNT_ID: "../x",
        ACCESS_POLICY_ID: POLICY,
        ACCESS_APP_ID: APP,
      }),
    ).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });
  test("defaults", () => {
    const c = configFromEnv({
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      ACCESS_POLICY_ID: POLICY,
      ACCESS_APP_ID: APP,
    });
    expect(c.port).toBe(8080);
    expect(c.tokenFile).toBe("/run/credentials/cloudflare-token");
    expect(c.resendKeyFile).toBeUndefined();
  });
});

describe("GET /guests", () => {
  test("lists the emails of the include rules", async () => {
    const res = await call("GET", "/guests");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ emails: ["one@example.test", "two@example.test"] });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  test("an empty include list is an empty guest list", async () => {
    policy.include = [];
    expect(await (await call("GET", "/guests")).json()).toEqual({ emails: [] });
  });
});

describe("PUT /guests", () => {
  test("replaces only include and sends every other field back unchanged", async () => {
    const before = freshPolicy();
    const res = await put(["one@example.test", "three@example.test"]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      emails: ["one@example.test", "three@example.test"],
      changed: true,
    });
    const [sent] = writes();
    const body = sent?.body as Record<string, unknown>;
    expect(emailsOf(body.include)).toEqual(["one@example.test", "three@example.test"]);
    expect(body.include).toEqual([
      { email: { email: "one@example.test" } },
      { email: { email: "three@example.test" } },
    ]);
    for (const [key, value] of Object.entries(before)) {
      if (key === "include" || READ_ONLY.includes(key)) continue;
      expect(body[key]).toEqual(value);
    }
    for (const key of READ_ONLY) expect(key in body).toBe(false);
    // And what Cloudflare kept is the same, apart from include.
    expect(policy.exclude).toEqual(before.exclude);
    expect(policy.some_future_field).toEqual(before.some_future_field);
  });

  test("sends a null session_duration back as null and drops other nulls", async () => {
    policy.purpose_justification_prompt = null;
    policy.session_duration = null;
    await put(["one@example.test"]);
    const body = (writes()[0] as Seen).body as Record<string, unknown>;
    expect("purpose_justification_prompt" in body).toBe(false);
    expect(body.session_duration).toBeNull();
  });

  test("a list equal to the current one writes nothing", async () => {
    const res = await put(["two@example.test", "one@example.test"]);
    expect(await res.json()).toEqual({
      emails: ["one@example.test", "two@example.test"],
      changed: false,
    });
    expect(writes()).toHaveLength(0);
    expect(logs.filter((l) => l.event === "audit")).toHaveLength(0);
  });

  test("writes one audit line", async () => {
    await put(["one@example.test", "three@example.test"]);
    const audit = logs.filter((l) => l.event === "audit");
    expect(audit).toEqual([
      {
        event: "audit",
        action: "guests.put",
        added: ["three@example.test"],
        removed: ["two@example.test"],
        count: 2,
        ok: true,
        verified: true,
      },
    ]);
  });

  test("an audit line also records a write Cloudflare refused", async () => {
    failNext = 500;
    failOn = "PUT";
    const res = await put(["one@example.test"]);
    expect(res.status).toBe(502);
    expect(logs.find((l) => l.event === "audit")).toMatchObject({ ok: false });
  });

  describe("refuses", () => {
    test("an include rule that is not a single email, with an alert and a 409", async () => {
      for (const rule of [
        { email_domain: { domain: "example.test" } },
        { everyone: {} },
        { email_list: { id: "x" } },
        { email: { email: "one@example.test" }, ip: { ip: "192.0.2.1/32" } },
        { email: { email: "one@example.test", extra: true } },
      ]) {
        policy.include = [{ email: { email: "one@example.test" } }, rule];
        seen = [];
        logs = [];
        const res = await put(["one@example.test", "new@example.test"]);
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe("policy_unexpected");
        expect(logs.find((l) => l.event === "alert")).toBeDefined();
        expect(writes()).toHaveLength(0);
      }
    });
    test("also when only reading", async () => {
      policy.include = [{ everyone: {} }];
      const res = await call("GET", "/guests");
      expect(res.status).toBe(409);
      expect(logs.find((l) => l.event === "alert")).toBeDefined();
    });
    test("a decision that is not allow", async () => {
      for (const decision of ["deny", "bypass", "non_identity"]) {
        policy.decision = decision;
        const res = await put(["one@example.test"]);
        expect(res.status).toBe(409);
        expect(logs.find((l) => l.event === "alert")).toBeDefined();
      }
      expect(writes()).toHaveLength(0);
    });
    test("removing the last guest (an empty list)", async () => {
      const res = await put([]);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("last_guest");
      expect(seen).toHaveLength(0);
    });
    test("bad emails, without any call to Cloudflare", async () => {
      const bad = [
        "Upper@example.test",
        "UPPER@EXAMPLE.TEST",
        `${"a".repeat(250)}@example.test`,
        "no-at-sign",
        "two@@example.test",
        "a@b@example.test",
        "@example.test",
        "one@",
        "*@example.test",
        "one@*.example.test",
        "*",
        "with space@example.test",
        "",
        42,
        null,
      ];
      for (const email of bad) {
        const res = await put([email]);
        expect(res.status).toBe(400);
      }
      expect(seen).toHaveLength(0);
    });
    test("exactly 254 characters is fine, 255 is not", async () => {
      const local = "a".repeat(254 - "@e.test".length);
      expect((await put([`${local}@e.test`])).status).toBe(200);
      expect((await put([`${local}a@e.test`])).status).toBe(400);
    });
    test("more than 25 guests; exactly 25 is fine", async () => {
      const many = (n: number) => Array.from({ length: n }, (_, i) => `g${i}@example.test`);
      expect((await put(many(26))).status).toBe(400);
      expect((await put(many(25))).status).toBe(200);
    });
    test("a repeated address, extra body fields, a non-JSON or oversized body", async () => {
      expect((await put(["one@example.test", "one@example.test"])).status).toBe(400);
      expect((await call("PUT", "/guests", { emails: ["a@example.test"], x: 1 })).status).toBe(400);
      expect((await call("PUT", "/guests", { emails: "a@example.test" })).status).toBe(400);
      const res = await handler.fetch(
        new Request(`http://${HOST}/guests`, {
          method: "PUT",
          headers: { host: HOST, "content-type": "application/json" },
          body: "{nope",
        }),
      );
      expect(res.status).toBe(400);
      const big = await handler.fetch(
        new Request(`http://${HOST}/guests`, {
          method: "PUT",
          headers: { host: HOST, "content-type": "application/json" },
          body: JSON.stringify({ emails: ["a@example.test"], pad: "x".repeat(20_000) }),
        }),
      );
      expect(big.status).toBe(413);
      const noType = await handler.fetch(
        new Request(`http://${HOST}/guests`, {
          method: "PUT",
          headers: { host: HOST },
          body: JSON.stringify({ emails: ["a@example.test"] }),
        }),
      );
      expect(noType.status).toBe(415);
      expect(seen).toHaveLength(0);
    });
    test("a second write while one is running", async () => {
      let release!: () => void;
      putGate = new Promise((resolve) => (release = resolve));
      const first = put(["one@example.test", "three@example.test"]);
      // Wait until the first write has reached the fake.
      while (!seen.some((s) => s.method === "PUT")) await Bun.sleep(5);
      const second = await put(["one@example.test", "four@example.test"]);
      expect(second.status).toBe(409);
      expect((await second.json()).error).toBe("write_in_progress");
      const revoking = await call("POST", "/revoke");
      expect(revoking.status).toBe(409);
      release();
      expect((await first).status).toBe(200);
      // The lock is free again.
      expect((await put(["one@example.test", "five@example.test"])).status).toBe(200);
    });
    test("more than 20 writes an hour, and counts again after the hour", async () => {
      for (let i = 0; i < MAX_WRITES_PER_HOUR; i++) {
        clock += 1000;
        expect((await put([`g${i}@example.test`])).status).toBe(200);
      }
      const res = await put(["over@example.test"]);
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      expect((await call("POST", "/revoke")).status).toBe(429);
      expect(writes()).toHaveLength(MAX_WRITES_PER_HOUR);
      clock += 60 * 60 * 1000;
      expect((await put(["over@example.test"])).status).toBe(200);
    });
    test("refused requests do not use up the hourly limit", async () => {
      for (let i = 0; i < 30; i++) await put([]);
      for (let i = 0; i < 30; i++) await put(["BAD"]);
      expect((await put(["fine@example.test"])).status).toBe(200);
    });
  });
});

describe("POST /revoke", () => {
  test("revokes the application's tokens and writes an audit line", async () => {
    const res = await call("POST", "/revoke");
    expect(res.status).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.path).toBe(`/accounts/${ACCOUNT}/access/apps/${APP}/revoke_tokens`);
    expect(logs.filter((l) => l.event === "audit")).toEqual([
      { event: "audit", action: "revoke", ok: true },
    ]);
  });
});

describe("GET /last-login", () => {
  test("the newest allowed entry of this app and this email", async () => {
    accessLogs = [
      {
        app_uid: APP,
        user_email: "one@example.test",
        allowed: true,
        created_at: "2026-11-05T10:00:00Z",
      },
      {
        app_uid: APP,
        user_email: "one@example.test",
        allowed: true,
        created_at: "2026-11-06T10:00:00Z",
      },
      // A later denied attempt, another app and another user do not count.
      {
        app_uid: APP,
        user_email: "one@example.test",
        allowed: false,
        created_at: "2026-11-07T10:00:00Z",
      },
      {
        app_uid: OTHER_APP,
        user_email: "one@example.test",
        allowed: true,
        created_at: "2026-11-07T11:00:00Z",
      },
      {
        app_uid: APP,
        user_email: "two@example.test",
        allowed: true,
        created_at: "2026-11-07T12:00:00Z",
      },
    ];
    const res = await call("GET", "/last-login?email=one@example.test");
    expect(await res.json()).toEqual({
      email: "one@example.test",
      lastLogin: "2026-11-06T10:00:00Z",
    });
    const query = new URL(`http://x${seen[0]?.path}${seen[0]?.search}`).searchParams;
    expect(query.get("email")).toBe("one@example.test");
    expect(query.get("emailOp")).toBe("eq");
  });
  test("null when there is none", async () => {
    const res = await call("GET", "/last-login?email=one@example.test");
    expect(await res.json()).toEqual({ email: "one@example.test", lastLogin: null });
  });
  test("refuses a bad email or extra parameters", async () => {
    for (const q of ["", "?email=ONE@example.test", "?email=*", "?email=a@b&x=1"])
      expect((await call("GET", `/last-login${q}`)).status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});

describe("notification routes (stub)", () => {
  test("check the body, then answer 501", async () => {
    expect((await call("POST", "/notify/invite", { email: "one@example.test" })).status).toBe(501);
    expect(
      (await call("POST", "/notify/published", { collection: "recipes", titles: ["A page"] }))
        .status,
    ).toBe(501);
    expect((await call("POST", "/notify/invite", { email: "BAD" })).status).toBe(400);
    expect(
      (await call("POST", "/notify/published", { collection: "x", titles: Array(11).fill("t") }))
        .status,
    ).toBe(400);
    expect(
      (await call("POST", "/notify/published", { collection: "x", titles: ["a\nb"] })).status,
    ).toBe(400);
    expect(seen).toHaveLength(0);
  });
});

describe("Host and path discipline", () => {
  test("another Host gets 404 and no call to Cloudflare", async () => {
    for (const host of ["evil.test", "share-admin.test", "share-admin.test:9090", ""]) {
      const res = await handler.fetch(
        new Request("http://other.test/guests", { headers: host ? { host } : {} }),
      );
      expect(res.status).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });
  test("the Host match ignores case", async () => {
    expect((await call("GET", "/guests", undefined, { host: HOST.toUpperCase() })).status).toBe(
      200,
    );
  });
  test("unknown paths are 404, wrong methods 405", async () => {
    expect((await call("GET", "/")).status).toBe(404);
    expect((await call("GET", "/guests/")).status).toBe(404);
    expect((await call("GET", "/policy")).status).toBe(404);
    expect((await call("DELETE", "/guests")).status).toBe(405);
    expect((await call("GET", "/revoke")).status).toBe(405);
    expect((await call("POST", "/guests", { emails: [] })).status).toBe(405);
    expect(seen).toHaveLength(0);
  });
  test("a browser request is refused", async () => {
    expect((await call("GET", "/guests", undefined, { origin: "https://evil.test" })).status).toBe(
      403,
    );
    expect(
      (await call("POST", "/revoke", undefined, { "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
    expect(seen).toHaveLength(0);
  });
  test("/healthz is not on the write port", async () => {
    expect((await call("GET", "/healthz")).status).toBe(404);
    const other = await handler.fetch(
      new Request("http://10.0.0.7:8080/healthz", { headers: { host: "10.0.0.7:8080" } }),
    );
    expect(other.status).toBe(404);
    expect(seen).toHaveLength(0);
  });
  test("works over a real socket too", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler.fetch });
    try {
      const ok = await fetch(`http://127.0.0.1:${server.port}/guests`, { headers: { host: HOST } });
      expect(ok.status).toBe(200);
      const wrong = await fetch(`http://127.0.0.1:${server.port}/guests`);
      expect(wrong.status).toBe(404);
    } finally {
      await server.stop(true);
    }
  });
});

describe("the token", () => {
  test("is read again on every request, so rotation needs no restart", async () => {
    await call("GET", "/guests");
    expect(seen.at(-1)?.auth).toBe(`Bearer ${TOKEN_A}`);
    currentToken = TOKEN_B;
    writeFileSync(tokenFile, `${TOKEN_B}\n`);
    clock += GUESTS_CACHE_MS + 1; // the answer to the first call was cached
    const res = await call("GET", "/guests");
    expect(res.status).toBe(200);
    expect(seen.at(-1)?.auth).toBe(`Bearer ${TOKEN_B}`);
  });
  test("a missing, empty or odd token file is a 503 and nothing is sent", async () => {
    for (const content of ["", "  \n", "has space", "tab\tbed"]) {
      writeFileSync(tokenFile, content);
      expect((await call("GET", "/guests")).status).toBe(503);
    }
    rmSync(tokenFile);
    expect((await call("GET", "/guests")).status).toBe(503);
    expect(seen).toHaveLength(0);
  });
  test("a token Cloudflare rejects is a 502, and the old one stops working", async () => {
    currentToken = TOKEN_B;
    const res = await call("GET", "/guests");
    expect(res.status).toBe(502);
  });
  test("never appears in a log line or an answer", async () => {
    const everything: string[] = [];
    const keep = async (res: Promise<Response>) => everything.push(await (await res).text());
    // Successes.
    await keep(call("GET", "/guests"));
    await keep(put(["one@example.test", "new@example.test"]));
    await keep(call("POST", "/revoke"));
    await keep(call("GET", "/last-login?email=one@example.test"));
    // Cloudflare errors whose text echoes the credential (the fake does).
    failNext = 500;
    failOn = "PUT";
    await keep(put(["one@example.test"]));
    currentToken = TOKEN_B;
    clock += GUESTS_CACHE_MS + 1;
    await keep(call("GET", "/guests"));
    await keep(call("POST", "/revoke"));
    // Refusals and an alert.
    policy.decision = "deny";
    await keep(put(["x@example.test"]));
    rmSync(tokenFile);
    await keep(call("GET", "/guests"));
    const text = everything.join("\n") + JSON.stringify(logs);
    expect(logs.length).toBeGreaterThan(3);
    for (const token of [TOKEN_A, TOKEN_B]) expect(text).not.toContain(token);
    expect(text).not.toContain("Bearer");
  });
  test("an unreachable Cloudflare is a 502", async () => {
    const dead = createHandler("http://127.0.0.1:1", config, { log: (e) => logs.push(e) });
    const res = await dead.fetch(new Request(`http://${HOST}/guests`, { headers: { host: HOST } }));
    expect(res.status).toBe(502);
  });
});

describe("the probe port", () => {
  const probe = (path: string, method = "GET", host?: string) =>
    createHealthHandler(config).fetch(
      new Request(`http://10.0.0.7:8081${path}`, { method, headers: host ? { host } : {} }),
    );
  test("answers /healthz on any Host and does not call Cloudflare", async () => {
    expect((await probe("/healthz")).status).toBe(200);
    expect((await probe("/healthz", "GET", "10.0.0.7:8081")).status).toBe(200);
    expect(seen).toHaveLength(0);
    rmSync(tokenFile);
    expect((await probe("/healthz")).status).toBe(503);
  });
  test("has no other route", async () => {
    for (const path of ["/guests", "/revoke", "/last-login?email=a@b.test", "/", "/healthz/x"])
      expect((await probe(path)).status).toBe(404);
    expect((await probe("/healthz", "POST")).status).toBe(405);
    expect(seen).toHaveLength(0);
  });
  test("the two ports must differ", () => {
    expect(() =>
      configFromEnv({
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
        ACCESS_POLICY_ID: POLICY,
        ACCESS_APP_ID: APP,
        PORT: "9000",
        HEALTH_PORT: "9000",
      }),
    ).toThrow(/differ/);
  });
});

describe("addresses that must never reach Cloudflare", () => {
  const cases: Record<string, string> = {
    zeroWidthSpace: "jo\u200bhn@example.test",
    softHyphen: "jo\u00adhn@example.test",
    nul: "jo\u0000hn@example.test",
    cyrillicA: "\u0430dmin@example.test",
    trailingDot: "john@example.test.",
    quotedLocal: '"john"@example.test',
    comment: "(c)john@example.test",
    noTld: "john@example",
    ipLiteral: "john@[192.0.2.1]",
    idn: "john@ex\u00e4mple.test",
    percentAt: "john%40evil.test@example.test@x.test",
    leadingDot: ".john@example.test",
    trailingDotInName: "john.@example.test",
    doubleDot: "jo..hn@example.test",
    doubleDotDomain: "john@example..test",
    rtlOverride: "john\u202e@example.test",
    emoji: "\u{1F600}@example.test",
    nonNfc: "jose\u0301@example.test",
    nfcAccent: "jos\u00e9@example.test",
    fullwidthAt: "john\uff20example.test",
    leadingDash: "john@-example.test",
  };
  for (const [name, email] of Object.entries(cases))
    test(name, async () => {
      const res = await put(["one@example.test", email]);
      expect(res.status).toBe(400);
      expect(seen).toHaveLength(0);
    });
  test("plain addresses with + and dots are accepted", async () => {
    expect((await put(["first.last+tag@mail.example.test"])).status).toBe(200);
  });
});

describe("policy identity", () => {
  const refused = async (change: () => void) => {
    change();
    const res = await put(["one@example.test", "attacker@example.test"]);
    expect(res.status).toBe(409);
    expect(logs.find((l) => l.event === "alert")).toBeDefined();
    expect(writes()).toHaveLength(0);
  };
  test("another name", () => refused(() => (policy.name = "owner-only admin apps")));
  test("not reusable", () => refused(() => (policy.reusable = false)));
  test("used by three applications", () => refused(() => (policy.app_count = 3)));
  test("used by no application", () => refused(() => (policy.app_count = 0)));
  test("an exclude rule", () => refused(() => (policy.exclude = [{ everyone: {} }])));
  test("a require rule", () =>
    refused(() => (policy.require = [{ email_domain: { domain: "example.test" } }])));
  test("the application does not list the policy", async () => {
    appPolicies = [{ id: "c".repeat(32) }];
    const res = await put(["one@example.test", "attacker@example.test"]);
    expect(res.status).toBe(409);
    expect(logs.find((l) => l.event === "alert")).toBeDefined();
    expect(writes()).toHaveLength(0);
  });
  test("the application is read before each write, and policies may be plain IDs", async () => {
    appPolicies = [POLICY];
    await put(["one@example.test", "a@example.test"]);
    await put(["one@example.test", "b@example.test"]);
    expect(seen.filter((s) => s.path.endsWith(`/apps/${APP}`))).toHaveLength(2);
  });
  test("the name can be configured", async () => {
    config = { ...config, policyName: "other name" };
    handler = createHandler(upstream, config, { log: (e) => logs.push(e), now: () => clock });
    policy.name = "other name";
    expect((await put(["one@example.test", "a@example.test"])).status).toBe(200);
  });
});

describe("read normalising", () => {
  test("a mixed-case or repeated address is returned lower case, once", async () => {
    policy.include = [
      { email: { email: "Guest@Example.test" } },
      { email: { email: "guest@example.test" } },
      { email: { email: "other@example.test" } },
    ];
    const got = await (await call("GET", "/guests")).json();
    expect(got.emails).toEqual(["guest@example.test", "other@example.test"]);
    // What GET returns can be sent back to PUT.
    expect((await put([...got.emails, "new@example.test"])).status).toBe(200);
  });
});

describe("what Cloudflare answers to a write", () => {
  test("a stored policy that is not what was asked for is an alert and a 502", async () => {
    const original = fake.fetch;
    // Wrap: the PUT answer says everyone is allowed.
    let first = true;
    const odd = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const response = await original.call(fake, request);
        if (request.method !== "PUT") return response;
        const json = (await response.json()) as { result: Record<string, unknown> };
        first = false;
        return Response.json({
          success: true,
          result: { ...json.result, include: [{ everyone: {} }] },
        });
      },
    });
    try {
      handler = createHandler(`http://127.0.0.1:${odd.port}`, config, {
        log: (e) => logs.push(e),
        now: () => clock,
      });
      const res = await put(["one@example.test", "late@example.test"]);
      expect(res.status).toBe(502);
      expect(first).toBe(false);
      expect(
        logs.find((l) => l.event === "alert" && l.reason === "stored-policy-differs"),
      ).toBeDefined();
      expect(logs.find((l) => l.event === "audit")).toMatchObject({ ok: true, verified: false });
    } finally {
      await odd.stop(true);
    }
  });
  test("a timeout after the request was sent is logged as ok unknown", async () => {
    putGate = new Promise(() => {});
    handler = createHandler(upstream, config, {
      log: (e) => logs.push(e),
      now: () => clock,
      upstreamTimeoutMs: 150,
    });
    // The GETs answer at once; the PUT hangs until the timeout.
    const res = await put(["one@example.test", "late@example.test"]);
    expect(res.status).toBe(502);
    expect(logs.find((l) => l.event === "audit")).toMatchObject({ ok: "unknown" });
  });
  test("a 401 or 403 is token_rejected with an alert", async () => {
    for (const status of [401, 403]) {
      logs = [];
      failNext = status;
      failOn = "POST";
      const res = await call("POST", "/revoke");
      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe("token_rejected");
      expect(logs.find((l) => l.event === "alert")).toMatchObject({ reason: "token-rejected" });
    }
  });
  test("a redirect is not followed", async () => {
    let hits = 0;
    const other = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        hits++;
        return Response.json({ success: true, result: policy });
      },
    });
    const redirecting = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${other.port}/x` },
        }),
    });
    try {
      const h = createHandler(`http://127.0.0.1:${redirecting.port}`, config, { log: () => {} });
      const res = await h.fetch(new Request(`http://${HOST}/guests`, { headers: { host: HOST } }));
      expect(res.status).toBe(502);
      expect(hits).toBe(0);
    } finally {
      await other.stop(true);
      await redirecting.stop(true);
    }
  });
  test("an HTML error page is a 502", async () => {
    const html = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("<html>bad gateway</html>", { status: 502 }),
    });
    try {
      const h = createHandler(`http://127.0.0.1:${html.port}`, config, { log: () => {} });
      const res = await h.fetch(new Request(`http://${HOST}/guests`, { headers: { host: HOST } }));
      expect(res.status).toBe(502);
    } finally {
      await html.stop(true);
    }
  });
});

describe("reads are cached", () => {
  test("GET /guests asks Cloudflare once in 30 seconds, and again after", async () => {
    for (let i = 0; i < 200; i++) await call("GET", "/guests");
    expect(seen).toHaveLength(1);
    clock += GUESTS_CACHE_MS + 1;
    await call("GET", "/guests");
    expect(seen).toHaveLength(2);
  });
  test("a write clears the cached list", async () => {
    await call("GET", "/guests");
    await put(["one@example.test", "new@example.test"]);
    const got = await (await call("GET", "/guests")).json();
    expect(got.emails).toEqual(["one@example.test", "new@example.test"]);
  });
  test("a refused read is not cached", async () => {
    policy.decision = "deny";
    expect((await call("GET", "/guests")).status).toBe(409);
    policy.decision = "allow";
    expect((await call("GET", "/guests")).status).toBe(200);
  });
  test("last-login asks once in 5 minutes per address", async () => {
    for (let i = 0; i < 50; i++) await call("GET", "/last-login?email=one@example.test");
    expect(seen).toHaveLength(1);
    await call("GET", "/last-login?email=two@example.test");
    expect(seen).toHaveLength(2);
    clock += LAST_LOGIN_CACHE_MS + 1;
    await call("GET", "/last-login?email=one@example.test");
    expect(seen).toHaveLength(3);
  });
  test("last-login asks for an exact email match", async () => {
    await call("GET", "/last-login?email=one@example.test");
    const q = new URLSearchParams(seen[0]?.search);
    expect(q.get("email_exact")).toBe("true");
  });
});

describe("parallel writes", () => {
  test("ten parallel PUTs make one write", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => put(["one@example.test", `p${i}@example.test`])),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
    expect(writes()).toHaveLength(1);
  });
});

describe("odd requests", () => {
  test("HEAD and OPTIONS are 405", async () => {
    expect((await call("HEAD", "/guests")).status).toBe(405);
    expect((await call("OPTIONS", "/guests")).status).toBe(405);
  });
  test("a 400 names unknown keys but never echoes values", async () => {
    const res = await call("PUT", "/guests", {
      emails: ["one@example.test"],
      CANARYKEY: "CANARYVALUE",
    });
    expect(await res.text()).not.toContain("CANARYVALUE");
  });
  test("last-login with a repeated parameter uses the last one, after the same check", async () => {
    expect((await call("GET", "/last-login?email=zzz&email=one@example.test")).status).toBe(200);
    expect((await call("GET", "/last-login?email=one@example.test&email=zzz")).status).toBe(400);
  });
  test("an unexpected error gives a plain 500 with no stack", async () => {
    const res = internalError(() => {});
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("at ");
  });
  test("over a real socket: odd Host lines never give a 5xx or a Cloudflare call", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 60,
      maxRequestBodySize: MAX_BODY_BYTES,
      fetch: handler.fetch,
      error: () => internalError(() => {}),
    });
    const raw = (req: string) =>
      new Promise<string>((resolve) => {
        const socket = connect(server.port as number, "127.0.0.1");
        let out = "";
        socket.on("data", (d) => (out += d.toString()));
        socket.on("end", () => resolve(out));
        socket.on("error", (e) => resolve(`ERR ${e.message}`));
        socket.write(req);
        setTimeout(() => socket.end(), 300);
      });
    try {
      const requests: Record<string, string> = {
        noHost10: "GET /guests HTTP/1.0\r\n\r\n",
        noHost11: "GET /guests HTTP/1.1\r\nConnection: close\r\n\r\n",
        weirdHost: "GET /guests HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n",
        slashHost: "GET /guests HTTP/1.1\r\nHost: x/y@z\r\nConnection: close\r\n\r\n",
        absoluteForm: `GET http://evil.test/guests HTTP/1.1\r\nHost: evil.test\r\nConnection: close\r\n\r\n`,
        dotSegments: `GET /x/../guests HTTP/1.1\r\nHost: evil.test\r\nConnection: close\r\n\r\n`,
        chunkedBig: `PUT /guests HTTP/1.1\r\nHost: ${HOST}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${(20000).toString(16)}\r\n${"x".repeat(20000)}\r\n0\r\n\r\n`,
      };
      for (const [name, req] of Object.entries(requests)) {
        seen = [];
        const out = await raw(req);
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(out)?.[1] ?? 0);
        // A refusal of some kind (or a closed socket), never a stack trace.
        expect(status === 0 || (status >= 400 && status < 500) || status === 500).toBe(true);
        expect(out).not.toContain("    at ");
        expect(
          seen.filter((s) => s.method === "PUT"),
          name,
        ).toHaveLength(0);
      }
    } finally {
      await server.stop(true);
    }
  });
});

describe("PATCH /guests", () => {
  const patch = (body: unknown, headers: Record<string, string> = {}) =>
    call("PATCH", "/guests", body, headers);

  test("applies a delta to the live policy and writes it back", async () => {
    const res = await patch({ add: ["three@example.test"], remove: ["one@example.test"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      emails: ["two@example.test", "three@example.test"],
      changed: true,
    });
    const body = writes()[0]?.body as Record<string, unknown>;
    expect(emailsOf(body.include)).toEqual(["two@example.test", "three@example.test"]);
    expect(body.some_future_field).toEqual({ nested: [1, 2, 3] });
    expect(logs.filter((l) => l.event === "audit")).toEqual([
      {
        event: "audit",
        action: "guests.patch",
        added: ["three@example.test"],
        removed: ["one@example.test"],
        count: 2,
        ok: true,
        verified: true,
      },
    ]);
  });

  test("a guest added in the dashboard after the app last read is not lost", async () => {
    // The app reads (and the service caches) the list ...
    expect((await (await call("GET", "/guests")).json()).emails).toHaveLength(2);
    // ... someone adds a guest in the dashboard ...
    (policy.include as unknown[]).push({ email: { email: "dash@example.test" } });
    // ... then the app adds another one with a delta.
    const res = await patch({ add: ["new@example.test"] });
    expect(await res.json()).toEqual({
      emails: ["one@example.test", "two@example.test", "dash@example.test", "new@example.test"],
      changed: true,
    });
    expect(emailsOf(policy.include)).toContain("dash@example.test");
    // The cache was cleared by the write.
    const got = await (await call("GET", "/guests")).json();
    expect(got.emails).toContain("new@example.test");
  });

  test("a removal does not drop a guest added in the dashboard either", async () => {
    await call("GET", "/guests");
    (policy.include as unknown[]).push({ email: { email: "dash@example.test" } });
    await patch({ remove: ["one@example.test"] });
    expect(emailsOf(policy.include)).toEqual(["two@example.test", "dash@example.test"]);
  });

  test("adding a listed address and removing an unlisted one change nothing", async () => {
    const res = await patch({ add: ["one@example.test"], remove: ["nobody@example.test"] });
    expect(await res.json()).toEqual({
      emails: ["one@example.test", "two@example.test"],
      changed: false,
    });
    expect(writes()).toHaveLength(0);
  });

  test("an address in both add and remove ends up added", async () => {
    const res = await patch({ add: ["new@example.test"], remove: ["new@example.test"] });
    expect((await res.json()).emails).toContain("new@example.test");
  });

  describe("refuses", () => {
    test("an empty result (the last guest)", async () => {
      const res = await patch({ remove: ["one@example.test", "two@example.test"] });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("last_guest");
      expect(writes()).toHaveLength(0);
    });
    test("more than 25 guests after the delta", async () => {
      policy.include = Array.from({ length: 25 }, (_, i) => ({
        email: { email: `g${i}@example.test` },
      }));
      const res = await patch({ add: ["extra@example.test"] });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("too_many_guests");
      expect(writes()).toHaveLength(0);
      // At exactly 25 it is fine: swap one.
      expect(
        (await patch({ add: ["extra@example.test"], remove: ["g0@example.test"] })).status,
      ).toBe(200);
    });
    test("bad bodies, without any call to Cloudflare", async () => {
      for (const body of [
        {},
        { add: [] },
        { add: [], remove: [] },
        { add: ["BAD@example.test"] },
        { add: ["*@example.test"] },
        { add: ["jo\u200bhn@example.test"] },
        { remove: ["no-at"] },
        { add: "one@example.test" },
        { add: ["a@example.test"], extra: 1 },
        { add: Array.from({ length: 26 }, (_, i) => `g${i}@example.test`) },
      ])
        expect((await patch(body)).status).toBe(400);
      expect(seen).toHaveLength(0);
    });
    test("a policy that fails the existing checks", async () => {
      for (const change of [
        () => (policy.decision = "deny"),
        () => (policy.name = "other"),
        () => (policy.app_count = 2),
        () => (policy.include = [{ everyone: {} }]),
        () => (policy.exclude = [{ everyone: {} }]),
        () => (appPolicies = [{ id: "c".repeat(32) }]),
      ]) {
        policy = freshPolicy();
        appPolicies = [{ id: POLICY }];
        logs = [];
        change();
        const res = await patch({ add: ["new@example.test"] });
        expect(res.status).toBe(409);
        expect(logs.find((l) => l.event === "alert")).toBeDefined();
        expect(writes()).toHaveLength(0);
      }
    });
    test("a policy that holds an address the schema refuses", async () => {
      policy.include = [
        { email: { email: "one@example.test" } },
        { email: { email: "jo\u200bhn@example.test" } },
      ];
      const res = await patch({ add: ["new@example.test"] });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("policy_unexpected");
      expect(writes()).toHaveLength(0);
    });
    test("a second write while one runs, and over 20 writes an hour", async () => {
      let release!: () => void;
      putGate = new Promise((resolve) => (release = resolve));
      const first = patch({ add: ["a@example.test"] });
      while (!seen.some((s) => s.method === "PUT")) await Bun.sleep(5);
      expect((await patch({ add: ["b@example.test"] })).status).toBe(409);
      release();
      expect((await first).status).toBe(200);
      for (let i = 0; i < MAX_WRITES_PER_HOUR - 1; i++) {
        clock += 1000;
        expect(
          (await patch({ add: [`n${i}@example.test`], remove: ["a@example.test"] })).status,
        ).toBe(i % 2 === 0 ? 200 : 200);
      }
      const over = await patch({ add: ["over@example.test"] });
      expect(over.status).toBe(429);
      expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    });
    test("a non-JSON content type and a browser request", async () => {
      expect((await call("PATCH", "/guests")).status).toBe(415);
      expect(
        (await patch({ add: ["a@example.test"] }, { origin: "https://evil.test" })).status,
      ).toBe(403);
    });
  });

  test("an audit line with ok unknown when Cloudflare times out after the send", async () => {
    putGate = new Promise(() => {});
    handler = createHandler(upstream, config, {
      log: (e) => logs.push(e),
      now: () => clock,
      upstreamTimeoutMs: 150,
    });
    const res = await patch({ add: ["late@example.test"] });
    expect(res.status).toBe(502);
    expect(logs.find((l) => l.event === "audit")).toMatchObject({
      action: "guests.patch",
      ok: "unknown",
    });
  });

  test("a stored policy that differs is an alert and a 502", async () => {
    const original = fake.fetch;
    const odd = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const response = await original.call(fake, request);
        if (request.method !== "PUT") return response;
        const json = (await response.json()) as { result: Record<string, unknown> };
        return Response.json({
          success: true,
          result: { ...json.result, include: [{ everyone: {} }] },
        });
      },
    });
    try {
      handler = createHandler(`http://127.0.0.1:${odd.port}`, config, {
        log: (e) => logs.push(e),
        now: () => clock,
      });
      expect((await patch({ add: ["late@example.test"] })).status).toBe(502);
      expect(logs.find((l) => l.reason === "stored-policy-differs")).toBeDefined();
    } finally {
      await odd.stop(true);
    }
  });

  test("never logs the token, even when Cloudflare echoes it", async () => {
    failNext = 500;
    failOn = "PUT";
    await patch({ add: ["a@example.test"] });
    currentToken = TOKEN_B;
    await patch({ add: ["b@example.test"] });
    expect(JSON.stringify(logs)).not.toContain(TOKEN_A);
    expect(JSON.stringify(logs)).not.toContain(TOKEN_B);
  });

  test("PUT keeps working as before, and 405 now lists PATCH", async () => {
    expect((await put(["one@example.test", "z@example.test"])).status).toBe(200);
    const res = await call("DELETE", "/guests");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, PUT, PATCH");
  });
});

describe("GET /guests freshness and address checks", () => {
  test("cache-control: no-cache bypasses the cache and refreshes it", async () => {
    await call("GET", "/guests");
    (policy.include as unknown[]).push({ email: { email: "dash@example.test" } });
    // Plain GET still sees the cached list.
    expect((await (await call("GET", "/guests")).json()).emails).toHaveLength(2);
    expect(seen).toHaveLength(1);
    const fresh = await (
      await call("GET", "/guests", undefined, { "cache-control": "no-cache" })
    ).json();
    expect(fresh.emails).toContain("dash@example.test");
    expect(seen).toHaveLength(2);
    // The fresh answer is now the cached one.
    expect((await (await call("GET", "/guests")).json()).emails).toContain("dash@example.test");
    expect(seen).toHaveLength(2);
  });
  test("a policy with an address the schema refuses is a 409 and an alert, not cached", async () => {
    for (const bad of ["jo\u200bhn@example.test", "*@example.test", "john@example", "a@b@c.test"]) {
      policy.include = [{ email: { email: "one@example.test" } }, { email: { email: bad } }];
      logs = [];
      const res = await call("GET", "/guests", undefined, { "cache-control": "no-cache" });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("policy_unexpected");
      expect(logs.find((l) => l.event === "alert")).toBeDefined();
    }
    policy.include = [{ email: { email: "one@example.test" } }];
    expect((await call("GET", "/guests")).status).toBe(200);
  });
  test("a mixed-case address is still fine (it is lower cased first)", async () => {
    policy.include = [{ email: { email: "Guest@Example.test" } }];
    expect((await call("GET", "/guests")).status).toBe(200);
  });
});
