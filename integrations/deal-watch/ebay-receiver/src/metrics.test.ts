import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { CANARY, KID, headerFor, notification, post, request, setup } from "./testkit.ts";

const scrape = async (r: ReturnType<typeof setup>["receiver"]) => {
  const out = await r.handleInternal(request("GET", "/metrics"));
  expect(out.status).toBe(200);
  expect(out.headers?.["content-type"]).toStartWith("text/plain; version=0.0.4");
  return out.body!;
};
const value = (text: string, series: string): number => {
  const line = text.split("\n").find((l) => l.startsWith(series + " "));
  if (!line) throw new Error("missing series " + series);
  return Number(line.slice(series.length + 1));
};

describe("/metrics", () => {
  test("is served on the internal handler only, GET only", async () => {
    const { receiver } = setup();
    expect((await receiver.handlePublic(request("GET", "/metrics"))).status).toBe(404);
    expect((await receiver.handleInternal(request("POST", "/metrics"))).status).toBe(405);
  });
  test("every series has HELP and TYPE, and every line is valid exposition text", async () => {
    const { receiver } = setup();
    const text = await scrape(receiver);
    for (const line of text.trim().split("\n"))
      expect(line).toMatch(/^(# (HELP|TYPE) [a-z_]+ .+|[a-z_]+(\{[a-z_]+="[A-Za-z0-9_.-]+"\})? -?[0-9.e+]+)$/);
    expect(text).toContain("# TYPE ebay_receiver_notifications_total counter");
    expect(text).toContain('ebay_receiver_info{storage_design_version="tier1-v1"} 1');
  });
  test("state gauges: CLEAR, then key-unavailable, then CLEAR again", async () => {
    const { receiver, ebay, clock } = setup();
    let t = await scrape(receiver);
    expect(value(t, 'ebay_receiver_state{reason="clear"}')).toBe(1);
    expect(value(t, "ebay_receiver_blocked")).toBe(0);
    ebay.mode.mint = "fail";
    await receiver.handlePublic(post(notification("m-1")));
    t = await scrape(receiver);
    expect(value(t, 'ebay_receiver_state{reason="key-unavailable"}')).toBe(1);
    expect(value(t, 'ebay_receiver_state{reason="clear"}')).toBe(0);
    expect(value(t, "ebay_receiver_blocked")).toBe(1);
    ebay.mode.mint = "ok";
    clock.t += 6 * 60_000;
    await receiver.handlePublic(post(notification("m-2")));
    expect(value(await scrape(receiver), "ebay_receiver_blocked")).toBe(0);
  });
  test("blocked by volume-reset and unprocessed show the right reason", async () => {
    const dead = setup({ init: "deny" });
    expect(value(await scrape(dead.receiver), 'ebay_receiver_state{reason="volume-reset"}')).toBe(1);
  });
  test("notification counters by fixed outcome", async () => {
    const { receiver, ebay } = setup();
    await receiver.handlePublic(post(notification("c-1")));
    await receiver.handlePublic(post(notification("c-1")));
    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const b = notification("c-2");
    await receiver.handlePublic(post(b, headerFor(b, KID, other.privateKey)));
    await receiver.handlePublic(post(b, "garbage"));
    await receiver.handlePublic(request("PUT", "/ebay/notify"));
    ebay.mode.keys = "404";
    const b3 = notification("c-3");
    await receiver.handlePublic(post(b3, headerFor(b3, "00000000-0000-0000-0000-0000000000aa")));
    const t = await scrape(receiver);
    expect(value(t, 'ebay_receiver_notifications_total{outcome="stored"}')).toBe(1);
    expect(value(t, 'ebay_receiver_notifications_total{outcome="duplicate"}')).toBe(1);
    expect(value(t, 'ebay_receiver_notifications_total{outcome="bad_signature"}')).toBe(1);
    expect(value(t, 'ebay_receiver_notifications_total{outcome="rejected_other"}')).toBe(2);
    expect(value(t, 'ebay_receiver_notifications_total{outcome="unknown_key"}')).toBe(1);
  });
  test("odd verified notification and storage failure counters", async () => {
    const { receiver, opened } = setup();
    await receiver.handlePublic(post(notification("o-1", "OTHER_TOPIC")));
    expect(value(await scrape(receiver), "ebay_receiver_notifications_odd_total")).toBe(1);
    opened.store!.close();
    await receiver.handlePublic(post(notification("o-2")));
    expect(value(await scrape(receiver), 'ebay_receiver_notifications_total{outcome="storage_failed"}')).toBe(1);
  });
  test("key lookup counters: ok, invalid, failed, budget", async () => {
    const { receiver, ebay } = setup();
    await receiver.handlePublic(post(notification("k-1")));
    ebay.mode.keys = "404";
    const bad = (n: number) => {
      const b = notification("k-bad" + n);
      return post(b, headerFor(b, `00000000-0000-0000-0000-00000000000${n}`));
    };
    await receiver.handlePublic(bad(1));
    ebay.mode.keys = "500";
    await receiver.handlePublic(bad(2));
    for (let n = 3; n < 9; n++) await receiver.handlePublic(bad(n));
    const t = await scrape(receiver);
    expect(value(t, 'ebay_receiver_key_lookups_total{outcome="ok"}')).toBe(1);
    expect(value(t, 'ebay_receiver_key_lookups_total{outcome="invalid"}')).toBe(1);
    expect(value(t, 'ebay_receiver_key_lookups_total{outcome="failed"}')).toBeGreaterThanOrEqual(2);
    expect(value(t, 'ebay_receiver_key_lookups_total{outcome="budget"}')).toBeGreaterThanOrEqual(1);
    expect(value(t, "ebay_receiver_key_lookup_failures_total")).toBe(value(t, 'ebay_receiver_key_lookups_total{outcome="failed"}'));
  });
  test("challenge and overload counters", async () => {
    const { receiver } = setup();
    await receiver.handlePublic(request("GET", "/ebay/notify?challenge_code=abc"));
    await receiver.handlePublic(request("GET", "/ebay/notify"));
    for (let i = 0; i < 30; i++) await receiver.handlePublic(request("GET", "/ebay/notify?challenge_code=a"));
    const t = await scrape(receiver);
    expect(value(t, 'ebay_receiver_challenges_total{outcome="ok"}')).toBeGreaterThan(1);
    expect(value(t, 'ebay_receiver_challenges_total{outcome="rejected"}')).toBe(1);
    expect(value(t, "ebay_receiver_overloaded_total")).toBeGreaterThan(0);
  });
  test("self-test gauges: failures in a row, reset on success, last success time", async () => {
    const { receiver, clock } = setup({ selfTest: true });
    let t = await scrape(receiver);
    expect(value(t, "ebay_receiver_selftest_enabled")).toBe(1);
    expect(value(t, "ebay_receiver_selftest_consecutive_failures")).toBe(0);
    expect(value(t, "ebay_receiver_selftest_last_success_timestamp_seconds")).toBe(0);
    receiver.noteSelfTest(false);
    receiver.noteSelfTest(false);
    expect(value(await scrape(receiver), "ebay_receiver_selftest_consecutive_failures")).toBe(2);
    receiver.noteSelfTest(true);
    t = await scrape(receiver);
    expect(value(t, "ebay_receiver_selftest_consecutive_failures")).toBe(0);
    expect(value(t, "ebay_receiver_selftest_last_success_timestamp_seconds")).toBe(Math.floor(clock.t / 1000));
  });
  test("no identifier can appear after feeding canary notifications", async () => {
    const { receiver } = setup();
    await receiver.handlePublic(post(notification("id-1")));
    const text = await scrape(receiver);
    for (const v of Object.values(CANARY)) expect(text).not.toContain(v);
    expect(text).not.toContain("id-1");
    expect(text).not.toContain(KID);
  });
});
