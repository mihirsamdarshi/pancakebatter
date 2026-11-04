import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { KID, TOKEN, ENDPOINT, headerFor, keypair, notification, post, request, setup } from "./testkit.ts";
import { generateKeyPairSync } from "node:crypto";

const rows = (dir: string) =>
  new Database(join(dir, "receiver.db"), { readonly: true }).query("SELECT * FROM notifications").all() as Record<string, unknown>[];

describe("challenge", () => {
  test("hash is sha256 hex of code + token + configured endpoint", async () => {
    const { receiver } = setup();
    const out = await receiver.handlePublic(request("GET", "/ebay/notify?challenge_code=abc123_-Z"));
    const expected = createHash("sha256").update("abc123_-Z" + TOKEN + ENDPOINT).digest("hex");
    expect(out.status).toBe(200);
    expect(out.headers?.["content-type"]).toBe("application/json");
    expect(JSON.parse(out.body!)).toEqual({ challengeResponse: expected });
  });
  test("a forged Host header cannot change the hash (endpoint is configuration)", async () => {
    const { receiver } = setup();
    const a = await receiver.handlePublic(request("GET", "/ebay/notify?challenge_code=abc", { host: "evil.example.test" }));
    const b = await receiver.handlePublic(request("GET", "/ebay/notify?challenge_code=abc"));
    expect(a.body).toBe(b.body);
  });
  test.each(["", "?challenge_code=", "?challenge_code=a&challenge_code=b", "?other=1", "?challenge_code=a%00b", "?challenge_code=" + "a".repeat(257)])(
    "rejects bad challenge %p with 400",
    async (q) => {
      const { receiver } = setup();
      expect((await receiver.handlePublic(request("GET", "/ebay/notify" + q))).status).toBe(400);
    },
  );
});

describe("routing", () => {
  test("only the configured path exists on the public port", async () => {
    const { receiver } = setup();
    for (const p of ["/", "/state", "/healthz", "/ebay/notify/", "/ebay", "/ebay/notifyx", "//ebay/notify"])
      expect((await receiver.handlePublic(request("GET", p))).status).toBe(404);
  });
  test("wrong method on the path is 405", async () => {
    const { receiver } = setup();
    for (const m of ["PUT", "DELETE", "HEAD", "PATCH"]) expect((await receiver.handlePublic(request(m, "/ebay/notify"))).status).toBe(405);
  });
  test("internal port serves only /state and /healthz", async () => {
    const { receiver } = setup();
    expect((await receiver.handleInternal(request("GET", "/healthz"))).status).toBe(200);
    expect((await receiver.handleInternal(request("GET", "/state"))).status).toBe(200);
    expect((await receiver.handleInternal(request("GET", "/ebay/notify"))).status).toBe(404);
    expect((await receiver.handleInternal(request("POST", "/state"))).status).toBe(405);
  });
});

describe("notification", () => {
  test("valid signed notification is stored then acknowledged; only ids and times are persisted", async () => {
    const { receiver, dir } = setup();
    const out = await receiver.handlePublic(post(notification("n-1_a")));
    expect(out.status).toBe(200);
    const r = rows(dir);
    expect(r).toHaveLength(1);
    expect(Object.keys(r[0]!).sort()).toEqual(["cleared_at", "event_date", "notification_id", "publish_attempt_count", "received_at", "state"]);
    expect(r[0]!.state).toBe("cleared");
    expect(JSON.stringify(r)).not.toMatch(/canary/i);
  });
  test("duplicate id: 200, no new row", async () => {
    const { receiver, dir } = setup();
    await receiver.handlePublic(post(notification("dup-1")));
    expect((await receiver.handlePublic(post(notification("dup-1")))).status).toBe(200);
    expect(rows(dir)).toHaveLength(1);
  });
  test("restart keeps the row (durable) and still dedupes", async () => {
    const a = setup();
    await a.receiver.handlePublic(post(notification("keep-1")));
    a.opened.store?.close();
    const { openStore } = await import("./store.ts");
    const again = openStore(a.dir, "deny");
    expect(again.store).not.toBeNull();
    expect(again.store!.record({ id: "keep-1", eventDate: "2026-11-03T00:00:00Z", publishAttemptCount: 1 }, 1)).toBe("duplicate");
  });
  test("signature case-insensitive header, charset in content type accepted", async () => {
    const { receiver } = setup();
    const body = notification("hdr-1");
    const req = request("POST", "/ebay/notify", { "Content-Type": "application/json; charset=utf-8", "X-EBAY-SIGNATURE": headerFor(body) }, body);
    expect((await receiver.handlePublic(req)).status).toBe(200);
  });
  test("pretty-printed body signed over compact JSON still verifies", async () => {
    const { receiver } = setup();
    const compact = notification("pp-1");
    const pretty = JSON.stringify(JSON.parse(compact), null, 2);
    expect((await receiver.handlePublic(post(pretty, headerFor(compact)))).status).toBe(200);
  });
  test("challenge accepts spaces and up to 256 characters (it is only hashed)", async () => {
    const { receiver } = setup();
    expect((await receiver.handlePublic(request("GET", "/ebay/notify?challenge_code=a%20b"))).status).toBe(200);
    expect((await receiver.handlePublic(request("GET", "/ebay/notify?challenge_code=" + "a".repeat(256)))).status).toBe(200);
  });
  test("missing or non-JSON content type is accepted when the signature verifies (L2)", async () => {
    const { receiver, dir } = setup();
    const a = notification("ct-1");
    expect((await receiver.handlePublic(request("POST", "/ebay/notify", { "x-ebay-signature": headerFor(a) }, a))).status).toBe(200);
    const b = notification("ct-2");
    expect((await receiver.handlePublic(request("POST", "/ebay/notify", { "content-type": "text/plain", "x-ebay-signature": headerFor(b) }, b))).status).toBe(200);
    expect(rows(dir)).toHaveLength(2);
    // size is still capped, and an unsigned body is still refused
    expect((await receiver.handlePublic(request("POST", "/ebay/notify", { "x-ebay-signature": headerFor(a) }, "x".repeat(20000)))).status).toBe(413);
    expect((await receiver.handlePublic(request("POST", "/ebay/notify", {}, a))).status).toBe(412);
  });
  test("early rejections: big 413, no signature 412, bad header 412", async () => {
    const { receiver, ebay } = setup();
    const body = notification("x-1");
    expect((await receiver.handlePublic(post("x".repeat(20000)))).status).toBe(413);
    expect((await receiver.handlePublic(request("POST", "/ebay/notify", { "content-type": "application/json", "content-length": "99999" }, "{}"))).status).toBe(413);
    expect((await receiver.handlePublic(request("POST", "/ebay/notify", { "content-type": "application/json" }, body))).status).toBe(412);
    expect((await receiver.handlePublic(post(body, "not a header"))).status).toBe(412);
    expect((await receiver.handlePublic(request("POST", "/ebay/notify", { "content-type": "application/json", "x-ebay-signature": headerFor(body) }, body, "timeout"))).status).toBe(408);
    expect(ebay.calls).toHaveLength(0); // none of these reach eBay
  });
  test("wrong signature 412 and nothing stored", async () => {
    const { receiver, dir } = setup();
    const body = notification("bad-1");
    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    expect((await receiver.handlePublic(post(body, headerFor(body, KID, other.privateKey)))).status).toBe(412);
    expect(rows(dir)).toHaveLength(0);
  });
  test("tampered body 412", async () => {
    const { receiver } = setup();
    const body = notification("tamper-1");
    expect((await receiver.handlePublic(post(body.replace("tamper", "tamxer"), headerFor(body)))).status).toBe(412);
  });
  test("unknown key id (404 from eBay) is 412 and cached", async () => {
    const { receiver, ebay } = setup();
    ebay.mode.keys = "404";
    const body = notification("unk-1");
    expect((await receiver.handlePublic(post(body))).status).toBe(412);
    const before = ebay.calls.length;
    expect((await receiver.handlePublic(post(body))).status).toBe(412);
    expect(ebay.calls.length).toBe(before);
  });
  test("verified message with another topic or odd shape is acknowledged with 200, never 400 (M1)", async () => {
    const { receiver, dir, lines } = setup();
    expect((await receiver.handlePublic(post(notification("t-1", "OTHER_TOPIC")))).status).toBe(200);
    const odd = JSON.stringify({ metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" }, notification: { notificationId: 12, eventDate: { x: 1 }, publishAttemptCount: "many", data: "?" } });
    expect((await receiver.handlePublic(post(odd))).status).toBe(200);
    expect((await receiver.handlePublic(post(odd))).status).toBe(200); // same body, same hash key
    expect((await receiver.handlePublic(post("{not json " + "canary_user_Zq81"))).status).toBe(200);
    const r = rows(dir);
    expect(r).toHaveLength(3);
    expect(r.filter((x) => String(x.notification_id).startsWith("body-"))).toHaveLength(2);
    expect(JSON.stringify(r)).not.toMatch(/canary/i);
    expect(lines.join("\n")).not.toMatch(/canary/i);
    expect(lines.join("\n")).toContain("notification-accepted-odd");
  });
  test("long or control-character notification id falls back to a body hash", async () => {
    const { receiver, dir } = setup();
    const long = JSON.parse(notification("x"));
    long.notification.notificationId = "a".repeat(201);
    expect((await receiver.handlePublic(post(JSON.stringify(long)))).status).toBe(200);
    long.notification.notificationId = "a\u0001b";
    expect((await receiver.handlePublic(post(JSON.stringify(long)))).status).toBe(200);
    expect(rows(dir).every((x) => String(x.notification_id).startsWith("body-"))).toBe(true);
  });
});

describe("503 until a key can be fetched; recovery", () => {
  test("mint failure and key-fetch 500 give 503, not stored, state BLOCKED key-unavailable", async () => {
    const { receiver, ebay, dir, clock } = setup();
    ebay.mode.mint = "fail";
    const body = notification("k-1");
    expect((await receiver.handlePublic(post(body))).status).toBe(503);
    expect(rows(dir)).toHaveLength(0);
    expect(receiver.state()).toEqual({ state: "BLOCKED", reason: "key-unavailable" });
    // retry after the negative cache and mint spacing expire
    ebay.mode.mint = "ok";
    clock.t += 6 * 60_000;
    expect((await receiver.handlePublic(post(body))).status).toBe(200);
    expect(receiver.state()).toEqual({ state: "CLEAR" });
  });
  test("failure is cached 5 minutes: no extra eBay calls", async () => {
    const { receiver, ebay } = setup();
    ebay.mode.keys = "500";
    await receiver.handlePublic(post(notification("c-1")));
    const n = ebay.calls.length;
    await receiver.handlePublic(post(notification("c-2")));
    expect(ebay.calls.length).toBe(n);
  });
  test("cached key keeps working while eBay is down (CLEAR)", async () => {
    const { receiver, ebay } = setup();
    await receiver.handlePublic(post(notification("w-1")));
    ebay.mode.keys = "500";
    ebay.mode.mint = "fail";
    expect((await receiver.handlePublic(post(notification("w-2")))).status).toBe(200);
    expect(receiver.state().state).toBe("CLEAR");
  });
  test("at most six key lookups an hour, then 503 without calling eBay", async () => {
    const { receiver, ebay } = setup();
    ebay.mode.keys = "404";
    for (let i = 0; i < 6; i++) {
      const kid = `00000000-0000-0000-0000-00000000000${i}`;
      const b = notification("f-" + i);
      expect((await receiver.handlePublic(post(b, headerFor(b, kid)))).status).toBe(412);
    }
    const n = ebay.calls.length;
    const b = notification("f-7");
    expect((await receiver.handlePublic(post(b, headerFor(b, "00000000-0000-0000-0000-000000000009")))).status).toBe(503);
    expect(ebay.calls.length).toBe(n);
  });
  test("a stalled key fetch times out (503) and the 9th concurrent request gets 429", async () => {
    const { receiver, ebay } = setup();
    ebay.mode.keys = "stall";
    const pending = Array.from({ length: 8 }, (_, i) => receiver.handlePublic(post(notification("s-" + i))));
    await Bun.sleep(20);
    expect((await receiver.handlePublic(post(notification("s-9")))).status).toBe(429);
    const results = await Promise.all(pending);
    expect(results.every((r) => r.status === 503)).toBe(true);
  }, 15000);
  test("a flood of challenge GETs and bad POSTs never makes a real notification get 429 (M2)", async () => {
    const { receiver } = setup();
    for (let i = 0; i < 60; i++) await receiver.handlePublic(request("GET", "/ebay/notify?challenge_code=a"));
    for (let i = 0; i < 60; i++) await receiver.handlePublic(post("{}", "garbage"));
    expect((await receiver.handlePublic(request("GET", "/ebay/notify?challenge_code=a"))).status).toBe(429);
    expect((await receiver.handlePublic(post(notification("after-flood")))).status).toBe(200);
  });
  test("rate limit: burst 20 then 429", async () => {
    const { receiver } = setup();
    let limited = 0;
    for (let i = 0; i < 30; i++) if ((await receiver.handlePublic(request("GET", "/ebay/notify?challenge_code=a"))).status === 429) limited++;
    expect(limited).toBe(10);
  });
});

describe("state", () => {
  test("CLEAR by default; reports design version and instance id", async () => {
    const { receiver } = setup();
    const out = await receiver.handleInternal(request("GET", "/state"));
    const body = JSON.parse(out.body!);
    expect(body.state).toBe("CLEAR");
    expect(body.storageDesignVersion).toBe("tier1-v1");
    expect(typeof body.instanceId).toBe("string");
  });
  test("a stored notification stuck unprocessed for 10 minutes blocks", async () => {
    const { receiver, dir, clock } = setup();
    new Database(join(dir, "receiver.db")).query("INSERT INTO notifications VALUES ('stuck', ?, 'x', 1, 'received', NULL)").run(clock.t - 11 * 60_000);
    expect(receiver.state()).toEqual({ state: "BLOCKED", reason: "unprocessed" });
  });
  test("self-test failing more than an hour blocks; success clears", () => {
    const { receiver, clock } = setup();
    receiver.noteSelfTest(false);
    clock.t += 59 * 60_000;
    expect(receiver.state().state).toBe("CLEAR");
    clock.t += 2 * 60_000;
    expect(receiver.state()).toEqual({ state: "BLOCKED", reason: "selftest-failed" });
    receiver.noteSelfTest(true);
    expect(receiver.state().state).toBe("CLEAR");
  });
  test("unreadable database blocks", () => {
    const { receiver, opened } = setup();
    opened.store!.close();
    expect(receiver.state()).toEqual({ state: "BLOCKED", reason: "db-unreadable" });
  });
  test("keypair export used", () => expect(keypair.publicKey.type).toBe("public"));
});
