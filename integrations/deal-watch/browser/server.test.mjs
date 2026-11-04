import test from "node:test";
import assert from "node:assert/strict";
import { validateRequest, buildUrl, isAllowedResponse, scrub, detectBlocked, isCaptchaVisible, drainPending, stripUrl, classifyError } from "./server.mjs";

test("validateRequest accepts good bodies", () => {
  const tp = "/p/-/A-93620188";
  assert.deepEqual(validateRequest({ retailer: "target", productId: "93620188", path: tp }), { ok: true, retailer: "target", productId: "93620188", path: tp });
  const bp = "/product/playstation-5-pro-console/JXHQ37TR86/sku/6601524";
  assert.equal(validateRequest({ retailer: "bestbuy", productId: "6601524", path: bp }).ok, true);
});

test("validateRequest rejects bad bodies", () => {
  for (const b of [null, [], "x", 5, {}, { retailer: "amazon", productId: "1" }, { retailer: "__proto__", productId: "1" },
    { retailer: "target", productId: "" }, { retailer: "target", productId: "1".repeat(21) }, { retailer: "target", productId: 123 },
    { retailer: "target", productId: "93620188" }, { retailer: "target", productId: "93620188", path: "/p/-/A-1" },
    { retailer: "target", productId: "93620188", path: "/p/-/A-93620188?x=1" }, { retailer: "target", productId: "93620188", path: "//evil.example/p/-/A-93620188" },
    { retailer: "bestbuy", productId: "6601524", path: "/site/6601524.p" }, { retailer: "bestbuy", productId: "6601524", path: "/product/x/JXHQ37TR86/sku/6601524#f" },
    { retailer: "bestbuy", productId: "6601524", path: "/product/x/abc/sku/6601524" }, { retailer: "bestbuy", productId: "6601524", path: "/product/x/JXHQ37TR86/sku/66015240" },
    { retailer: "bestbuy", productId: "6601524", path: "/product/X/JXHQ37TR86/sku/6601524" }, { retailer: "target", productId: "12a", path: "/p/-/A-12a" }, { retailer: "target", productId: "1/../2" }, { retailer: "toString", productId: "1" }]) {
    assert.equal(validateRequest(b).ok, false, JSON.stringify(b));
  }
});

test("buildUrl", () => {
  assert.equal(buildUrl("target", "/p/-/A-93620188"), "https://www.target.com/p/-/A-93620188");
  assert.equal(buildUrl("bestbuy", "/product/a/JXHQ37TR86/sku/6601524"), "https://www.bestbuy.com/product/a/JXHQ37TR86/sku/6601524");
});

test("path allowlist", () => {
  const t = "https://www.target.com/cdui_orchestrations/v1/pages/pdp/deferred_enrichment/modules?x=1";
  assert.equal(isAllowedResponse("target", t), true);
  assert.equal(isAllowedResponse("bestbuy", t), false);
  assert.equal(isAllowedResponse("bestbuy", "https://www.bestbuy.com/gateway/graphql/fulfillment"), true);
  assert.equal(isAllowedResponse("bestbuy", "https://www.bestbuy.com/gateway/graphql/other"), false);
  assert.equal(isAllowedResponse("bestbuy", "https://evil.example/gateway/graphql"), false);
  assert.equal(isAllowedResponse("bestbuy", "http://www.bestbuy.com/gateway/graphql"), false);
  assert.equal(isAllowedResponse("target", "not a url"), false);
});

test("scrub removes sensitive keys recursively", () => {
  const out = scrub({ price: 1, apiKey: "a", nested: [{ visitorId: 1, ok: 2, deep: { Session_Id: 3, keep: 4 } }], EMAIL: "x", guestId: 1, deviceType: "x" });
  assert.deepEqual(out, { price: 1, nested: [{ ok: 2, deep: { keep: 4 } }] });
});

test("detectBlocked", () => {
  assert.equal(detectBlocked({ title: "Access Denied" }), true);
  assert.equal(detectBlocked({ text: "Please PRESS & HOLD to confirm" }), true);
  assert.equal(detectBlocked({ h1: ["Pardon Our Interruption"] }), true);
  assert.equal(detectBlocked({ hasCaptcha: true }), true);
  assert.equal(detectBlocked({ title: "PlayStation 5 : Target", text: "Add to cart" }), false);
});

test("stripUrl drops query and fragment", () => {
  assert.equal(stripUrl("https://www.target.com/p/-/A-1?a=b#c"), "https://www.target.com/p/-/A-1");
  assert.equal(stripUrl("garbage"), "");
});

test("classifyError", () => {
  assert.equal(classifyError({ name: "TimeoutError", message: "x" }), "timeout");
  assert.equal(classifyError({ message: "Target page, context or browser has been closed" }), "browser");
  assert.equal(classifyError({ message: "net::ERR_NAME_NOT_RESOLVED" }), "navigation");
});

import { hostMatches, withDeadline, isBusyTooLong, BLOCK_TEXT } from "./server.mjs";

test("hostMatches", () => {
  assert.equal(hostMatches("target", "https://www.target.com/p/-/A-1"), true);
  assert.equal(hostMatches("target", "https://www.bestbuy.com/x"), false);
  assert.equal(hostMatches("bestbuy", "https://www.bestbuy.com.evil.example/x"), false);
  assert.equal(hostMatches("bestbuy", "about:blank"), false);
  assert.equal(hostMatches("bestbuy", ""), false);
});

test("withDeadline returns the fallback on a hung promise and clears busy-like state", async () => {
  const hung = new Promise(() => {});
  assert.equal(await withDeadline(hung, 20, () => "timed-out"), "timed-out");
  assert.equal(await withDeadline(Promise.resolve("ok"), 1000, () => "timed-out"), "ok");
});

test("isBusyTooLong", () => {
  assert.equal(isBusyTooLong(null, 1e9), false);
  assert.equal(isBusyTooLong(1000, 1000 + 130_000), false);
  assert.equal(isBusyTooLong(1000, 1000 + 130_001), true);
});

test("new block phrases", () => {
  for (const p of ["Verify you are human", "Checking your browser", "unusual traffic", "Please solve the CAPTCHA", "Request unsuccessful. Incapsula"])
    assert.equal(BLOCK_TEXT.test(p), true, p);
});

import { chromePids } from "./server.mjs";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("chromePids finds only Chrome processes", () => {
  const root = mkdtempSync(join(tmpdir(), "proc-"));
  for (const [pid, cmd] of [["10", "/opt/google/chrome/chrome\0--type=zygote"], ["11", "Xvfb\0:99"], ["12", "/opt/google/chrome/chrome"]]) {
    mkdirSync(join(root, pid));
    writeFileSync(join(root, pid, "cmdline"), cmd);
  }
  mkdirSync(join(root, "self"));
  assert.deepEqual(chromePids(root, 999).sort(), [10, 12]);
});

const shown = { display: "block", visibility: "visible", opacity: "1" };
const box = { width: 1280, height: 720 };
const none = { width: 0, height: 0 };
const normal = { title: "PlayStation 5 Pro Console : Target", h1: ["PlayStation 5 Pro Console"], text: "Add to cart" };

test("hidden px-captcha-modal iframe does not block", () => {
  const hidden = [
    { chain: [{ ...shown, display: "none" }], rect: none },
    { chain: [shown, { ...shown, display: "none" }], rect: box },
    { chain: [{ ...shown, visibility: "hidden" }], rect: box },
    { chain: [shown, { ...shown, opacity: "0" }], rect: box },
    { chain: [shown], rect: { width: 0, height: 720 } },
  ];
  for (const c of hidden) {
    assert.equal(isCaptchaVisible(c), false);
    assert.equal(detectBlocked({ ...normal, captchas: [c] }), false);
  }
});

test("visible px-captcha element blocks, wherever it sits", () => {
  for (const rect of [box, { width: 500, height: 300 }]) {
    assert.equal(isCaptchaVisible({ chain: [shown, shown], rect }), true);
  }
  assert.equal(detectBlocked({ ...normal, captchas: [{ chain: [shown], rect: { width: 0, height: 5 } }, { chain: [shown], rect: box }] }), true);
  assert.equal(detectBlocked({ ...normal, captchas: [] }), false);
});

test("a visible challenge below the fold or partly off-screen still blocks", () => {
  // Position is not part of the record: below-the-fold and partly-clipped boxes have area.
  assert.equal(detectBlocked({ ...normal, captchas: [{ chain: [shown], rect: { width: 530, height: 340 } }] }), true);
});

test("zero-size wrapper: a visible child blocks, only hidden children do not", () => {
  const wrapper = (descendants) => ({ chain: [shown], rect: none, descendants });
  assert.equal(isCaptchaVisible(wrapper([{ chain: [shown, shown], rect: box }])), true);
  assert.equal(isCaptchaVisible(wrapper([{ chain: [{ ...shown, display: "none" }, shown], rect: box }, { chain: [shown], rect: none }])), false);
  assert.equal(isCaptchaVisible(wrapper([])), false);
});

test("block text still blocks beside a hidden captcha", () => {
  const hidden = { chain: [{ ...shown, display: "none" }], rect: none };
  assert.equal(detectBlocked({ ...normal, text: "Press & hold to confirm", captchas: [hidden] }), true);
});

test("drainPending waits for handlers added while waiting, within the cap", async () => {
  const pending = [];
  let done = false;
  pending.push(new Promise((ok) => setTimeout(() => { pending.push(new Promise((ok2) => setTimeout(() => { done = true; ok2(); }, 30))); ok(); }, 30)));
  await drainPending(pending, 2000);
  assert.equal(done, true);
  const t0 = Date.now();
  await drainPending([new Promise(() => {})], 80);
  assert.ok(Date.now() - t0 < 1000);
});
