// Deal Watch browser service: one page load per request, contract in the
// "browser API contract" (POST /observe, GET /healthz). The caller never
// supplies a URL; this file builds it from a retailer name and a numeric id.
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const RETAILERS = {
  target: {
    host: "www.target.com",
    pathOk: (p, id) => p === `/p/-/A-${id}`,
    paths: ["/cdui_orchestrations/v1/pages/pdp/deferred_enrichment/modules"],
  },
  bestbuy: {
    host: "www.bestbuy.com",
    pathOk: (p, id) => new RegExp(`^/product/[a-z0-9-]{1,120}/[A-Z0-9]{6,16}/sku/${id}$`).test(p),
    paths: ["/gateway/graphql", "/gateway/graphql/fulfillment"],
  },
};

export const MAX_BODY_BYTES = 1024;
export const MAX_CAPTURE_BYTES = 1024 * 1024;
export const MAX_RESPONSES = 12;
export const SCRUB_KEYS = /key|token|session|cookie|visitor|auth|secret|password|email|guest|device/i;
export const BLOCK_TEXT =
  /press & hold|quick verification|robot or human|access denied|just a moment|pardon our interruption|are you a human|verify you are human|checking your browser|unusual traffic|captcha|request unsuccessful/i;
export const OBSERVE_DEADLINE_MS = 100_000;
export const BUSY_UNHEALTHY_MS = 130_000;
export const CLOSE_CAP_MS = 5_000;
// Target's page script fetches its data about 0.3 s after DOMContentLoaded, so wait for it.
export const DATA_WAIT_MS = 20_000;

export function validateRequest(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const { retailer, productId, path } = raw;
  if (typeof retailer !== "string" || !Object.hasOwn(RETAILERS, retailer)) return { ok: false };
  if (typeof productId !== "string" || !/^[0-9]{1,20}$/.test(productId)) return { ok: false };
  if (typeof path !== "string" || path.length > 300 || !RETAILERS[retailer].pathOk(path, productId)) return { ok: false };
  return { ok: true, retailer, productId, path };
}

export function buildUrl(retailer, path) {
  return `https://${RETAILERS[retailer].host}${path}`;
}

export function isAllowedResponse(retailer, urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return false;
  }
  const r = RETAILERS[retailer];
  return u.protocol === "https:" && u.host === r.host && r.paths.includes(u.pathname);
}

export function scrub(node, depth = 0) {
  if (depth > 40) return null;
  if (Array.isArray(node)) return node.map((v) => scrub(v, depth + 1));
  if (node !== null && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (SCRUB_KEYS.test(k)) continue;
      out[k] = scrub(v, depth + 1);
    }
    return out;
  }
  return node;
}

export function stripUrl(urlString) {
  try {
    const u = new URL(urlString);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

// A captcha element counts only when a person could see it: the element and every
// ancestor are displayed, visible and not transparent, and its box has area inside the viewport.
// `rec` = { chain: [{display, visibility, opacity}, ...element then ancestors], rect: {left, top, right, bottom, width, height} }.
export function isCaptchaVisible(rec, viewport) {
  if (!rec || !Array.isArray(rec.chain) || !rec.rect || !viewport) return false;
  for (const s of rec.chain) {
    if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return false;
    if (!(Number(s.opacity) > 0)) return false;
  }
  const r = rec.rect;
  if (!(r.width > 0 && r.height > 0)) return false;
  return r.right > 0 && r.bottom > 0 && r.left < viewport.width && r.top < viewport.height;
}

export function detectBlocked({ title = "", h1 = [], text = "", hasCaptcha = false, captchas = [], viewport = null }) {
  if (hasCaptcha || captchas.some((c) => isCaptchaVisible(c, viewport))) return true;
  return BLOCK_TEXT.test(`${title}\n${h1.join("\n")}\n${text}`);
}

export function hostMatches(retailer, finalUrl) {
  try {
    return new URL(finalUrl).host === RETAILERS[retailer].host;
  } catch {
    return false;
  }
}

// Resolves with the promise's value, or with `onTimeout()` after `ms`. Never rejects on timeout.
export function withDeadline(promise, ms, onTimeout) {
  let timer;
  const t = new Promise((ok) => {
    timer = setTimeout(() => ok(onTimeout()), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

// Awaits every handler in `pending`, including ones pushed while waiting, until none is
// outstanding or `ms` has passed. Never rejects.
export async function drainPending(pending, ms) {
  const end = Date.now() + ms;
  let seen = 0;
  while (seen < pending.length && Date.now() < end) {
    const batch = pending.slice(seen);
    seen = pending.length;
    await withDeadline(Promise.allSettled(batch), Math.max(0, end - Date.now()), () => {});
  }
}

export function isBusyTooLong(busySince, now, limit = BUSY_UNHEALTHY_MS) {
  return busySince !== null && now - busySince > limit;
}

// Pids of processes whose command line runs the installed Chrome binary.
export function chromePids(procRoot = "/proc", self = process.pid) {
  const pids = [];
  for (const name of readdirSync(procRoot)) {
    if (!/^[0-9]+$/.test(name) || Number(name) === self) continue;
    try {
      if (readFileSync(`${procRoot}/${name}/cmdline`, "utf8").startsWith("/opt/google/chrome/")) pids.push(Number(name));
    } catch {
      /* process went away */
    }
  }
  return pids;
}

export function classifyError(e) {
  const name = e && e.name;
  const msg = String((e && e.message) || "");
  if (name === "TimeoutError" || /timeout/i.test(msg)) return "timeout";
  if (/browser has been closed|has been closed|disconnected|crash|target closed/i.test(msg)) return "browser";
  return "navigation";
}

// ---- runtime (only when run directly) ----
async function main() {
  const { chromium } = await import("playwright-core");
  let browser = null;
  let launching = null;
  let busySince = null;
  let xvfbUp = process.env.DISPLAY_EXTERNAL === "1";
  let xvfb = null;

  function startXvfb() {
    if (xvfbUp) return;
    process.env.DISPLAY = ":99";
    xvfb = spawn("Xvfb", [":99", "-screen", "0", "1920x1080x24", "-nolisten", "tcp"], { stdio: "ignore" });
    xvfb.on("exit", () => {
      xvfbUp = false;
      console.error("Xvfb exited");
    });
    xvfb.on("error", () => {
      xvfbUp = false;
    });
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (existsSync("/tmp/.X11-unix/X99") || Date.now() - t0 > 10_000) clearInterval(poll);
      if (existsSync("/tmp/.X11-unix/X99")) xvfbUp = true;
    }, 100);
  }

  async function killBrowser() {
    const b = browser;
    browser = null;
    if (!b) return;
    let closed = false;
    await withDeadline(b.close().then(() => (closed = true), () => (closed = true)), CLOSE_CAP_MS, () => {});
    if (!closed) {
      // close() hung: SIGKILL every Chrome process so none survives as an orphan.
      for (const pid of chromePids()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }

  async function ensureBrowser() {
    if (browser && browser.isConnected()) return browser;
    if (!launching) {
      // Headed Chromium under Xvfb. Playwright launches Chromium without its
      // sandbox by default (chromiumSandbox: false); we keep that because the
      // pod runs non-root with all capabilities dropped and no user namespaces.
      launching = chromium
        .launch({
          channel: "chrome", // Google Chrome stable installed in the image
          headless: false,
          chromiumSandbox: false,
          args: ["--window-size=1366,768"],
          timeout: 30_000,
        })
        .then((b) => {
          browser = b;
          b.on("disconnected", () => {
            if (browser === b) browser = null;
          });
          return b;
        })
        .finally(() => {
          launching = null;
        });
    }
    return launching;
  }

  async function observe({ retailer, productId, path }, state) {
    const startedAt = Date.now();
    const result = {
      retailer,
      productId,
      startedAt,
      finishedAt: 0,
      status: null,
      finalUrl: "",
      blocked: false,
      error: null,
      title: "",
      h1: [],
      responses: [],
    };
    let context = null;
    try {
      const b = await ensureBrowser();
      // Genuine settings only: no user-agent, navigator or fingerprint changes.
      context = await b.newContext({ locale: "en-US", timezoneId: "America/Los_Angeles", viewport: null });
      state.context = context;
      const page = await context.newPage();
      await page.route("**/*", (route) =>
        ["image", "media", "font"].includes(route.request().resourceType()) ? route.abort() : route.continue(),
      );
      const pending = [];
      const handle = async (res) => {
        try {
          if (result.responses.length >= MAX_RESPONSES) return;
          if (!isAllowedResponse(retailer, res.url())) return;
          if (!(res.headers()["content-type"] || "").includes("json")) return;
          const declared = Number(res.headers()["content-length"]);
          if (Number.isFinite(declared) && declared > MAX_CAPTURE_BYTES) return;
          const text = await res.text();
          if (text.length > MAX_CAPTURE_BYTES || !text.includes(productId)) return;
          if (result.responses.length >= MAX_RESPONSES) return;
          result.responses.push({
            path: new URL(res.url()).pathname,
            status: res.status(),
            body: scrub(JSON.parse(text)),
          });
        } catch {
          /* unreadable or non-JSON body: skip */
        }
      };
      page.on("response", (res) => pending.push(handle(res)));
      // Armed before navigation so a fast response is never missed; bounded, never rejects.
      const wanted = page
        .waitForResponse((res) => isAllowedResponse(retailer, res.url()) && res.status() === 200, { timeout: DATA_WAIT_MS })
        .catch(() => null);
      try {
        const resp = await page.goto(buildUrl(retailer, path), {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        result.status = resp ? resp.status() : null;
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      } catch (e) {
        result.error = classifyError(e);
      }
      if (!result.error) await wanted;
      await drainPending(pending, 10_000);
      result.finalUrl = stripUrl(page.url());
      if (!hostMatches(retailer, result.finalUrl)) result.error ??= "navigation";
      try {
        const dom = await page.evaluate(() => ({
          title: document.title,
          h1: [...document.querySelectorAll("h1")].map((h) => h.innerText.trim()).slice(0, 3),
          text: (document.body ? document.body.innerText : "").slice(0, 20000),
          viewport: { width: window.innerWidth, height: window.innerHeight },
          captchas: [...document.querySelectorAll("#px-captcha, [id*='px-captcha'], [class*='px-captcha']")].slice(0, 20).map((el) => {
            const chain = [];
            for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
              const c = getComputedStyle(n);
              chain.push({ display: c.display, visibility: c.visibility, opacity: c.opacity });
            }
            const b = el.getBoundingClientRect();
            return { chain, rect: { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height } };
          }),
        }));
        result.title = dom.title;
        result.h1 = dom.h1;
        result.blocked = detectBlocked(dom);
      } catch (e) {
        result.error ??= classifyError(e);
      }
    } catch (e) {
      result.error = "browser";
      console.error("observe failed:", e && e.name);
    } finally {
      if (context) await closeContext(context);
      result.finishedAt = Date.now();
    }
    return result;
  }

  async function closeContext(context) {
    let closed = false;
    await withDeadline(context.close().then(() => (closed = true), () => (closed = true)), CLOSE_CAP_MS, () => {});
    if (!closed) await killBrowser();
  }

  // Hard deadline: the caller always gets an answer and busy is always cleared.
  async function observeWithDeadline(v) {
    const state = { context: null };
    const startedAt = Date.now();
    return withDeadline(observe(v, state), OBSERVE_DEADLINE_MS, () => {
      // Force-close in the background; the late observe() result is discarded.
      if (state.context) closeContext(state.context).catch(() => {});
      return {
        retailer: v.retailer, productId: v.productId, startedAt, finishedAt: Date.now(), status: null,
        finalUrl: "", blocked: false, error: "timeout", title: "", h1: [], responses: [],
      };
    });
  }

  function send(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  }

  const server = http.createServer((req, res) => {
    const path = (req.url || "").split("?")[0];
    if (req.method === "GET" && path === "/healthz") {
      const ok = !!(browser && browser.isConnected()) && xvfbUp && !isBusyTooLong(busySince, Date.now());
      // Lazily (re)launch so a dead browser recovers without a pod restart.
      if (!ok && xvfbUp && busySince === null) ensureBrowser().catch((e) => console.error("launch failed:", e && e.name));
      return send(res, ok ? 200 : 503, { ok, chromeVersion: ok ? browser.version() : null });
    }
    if (req.method !== "POST" || path !== "/observe") return send(res, 404, { error: "not found" });
    let size = 0;
    const chunks = [];
    let tooBig = false;
    req.on("data", (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        send(res, 400, { error: "bad request" });
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", async () => {
      if (tooBig) return;
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(res, 400, { error: "bad request" });
      }
      const v = validateRequest(parsed);
      if (!v.ok) return send(res, 400, { error: "bad request" });
      if (busySince !== null) return send(res, 429, { error: "busy" });
      busySince = Date.now();
      try {
        send(res, 200, await observeWithDeadline(v));
      } catch {
        send(res, 500, { error: "internal" });
      } finally {
        busySince = null;
      }
    });
  });
  server.requestTimeout = 120_000;
  server.listen(Number(process.env.PORT || 3000), "0.0.0.0", () => {
    console.log("deal-watch-browser listening");
    startXvfb();
    const wait = setInterval(() => {
      if (xvfbUp) {
        clearInterval(wait);
        ensureBrowser().catch((e) => console.error("launch failed:", e && e.name));
      }
    }, 200);
    wait.unref();
  });
  const stop = () => {
    xvfb?.kill();
    server.close(() => killBrowser().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
