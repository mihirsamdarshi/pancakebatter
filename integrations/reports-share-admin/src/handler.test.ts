import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromEnv, type Config } from "./config.ts";
import { createHandler, MAX_WRITES_PER_HOUR, type Handler } from "./handler.ts";

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
    exclude: [{ ip: { ip: "192.0.2.1/32" } }],
    require: [{ country: { country_code: "US" } }],
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
        policy = { id: POLICY, account_id: ACCOUNT, ...body };
        return Response.json({ success: true, result: policy });
      }
    }
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

  test("drops a null field (the same as unset) instead of sending it", async () => {
    policy.purpose_justification_prompt = null;
    await put(["one@example.test"]);
    expect("purpose_justification_prompt" in ((writes()[0] as Seen).body as object)).toBe(false);
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
  test("/healthz answers on any Host and does not call Cloudflare", async () => {
    const res = await handler.fetch(
      new Request("http://10.0.0.7:8080/healthz", { headers: { host: "10.0.0.7:8080" } }),
    );
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(0);
    rmSync(tokenFile);
    expect((await handler.fetch(new Request("http://10.0.0.7:8080/healthz"))).status).toBe(503);
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
