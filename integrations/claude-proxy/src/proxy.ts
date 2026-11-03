import { readFileSync } from "node:fs";
import type { Server } from "bun";
import {
  costUsd,
  DEFAULT_MAX_TOKENS,
  estimateUsd,
  hasPrice,
  NO_USAGE,
  type Billing,
} from "./prices.ts";
import { SpendLedger, type Logger } from "./spend.ts";
import { UsageTracker } from "./usage.ts";

export const MAX_BODY_BYTES = 16 * 1024 * 1024;
// The whole request body must arrive within this time.
export const BODY_TIMEOUT_MS = 60_000;
// A ceiling for one upstream request, streaming included. The Anthropic SDKs
// allow up to 60 minutes for the longest non-streaming requests.
const UPSTREAM_TIMEOUT_MS = 60 * 60 * 1000;

export const DEFAULT_KEY_FILE = "/run/credentials/anthropic-api-key";
export const DEFAULT_SPEND_FILE = "/tmp/claude-proxy-spend.json";
export const DEFAULT_ALLOWED_MODELS = "claude-opus-5-5,claude-haiku-5-5";

const MESSAGES = "/v1/messages";
const COUNT_TOKENS = "/v1/messages/count_tokens";
// Request headers copied from the caller; every other header (x-api-key,
// authorization, cookie, host, hop-by-hop, x-stainless-*, ...) is dropped.
// anthropic-beta passes unchanged: the CLI sends several betas, and the
// request fields that change the price are checked instead.
const REQUEST_HEADERS = [
  "content-type",
  "accept",
  "anthropic-version",
  "anthropic-beta",
  "user-agent",
];
// Response headers copied to the caller. set-cookie is never copied.
// content-encoding and content-length are not copied either: fetch has
// already decompressed the body.
const RESPONSE_HEADERS = ["content-type", "request-id", "retry-after", "x-should-retry"];
// The Anthropic SDKs obey x-should-retry before their status rules (which
// retry 408, 409, 429 and 5xx). Refusals that a retry cannot fix carry it.
const NO_RETRY = { "x-should-retry": "false" };

export interface ProxyConfig {
  keyFile: string;
  allowedModels: readonly string[];
  dailyCapUsd: number;
  spendFile: string;
  maxConcurrent: number;
}

export interface HandlerOptions extends ProxyConfig {
  log?: Logger;
  now?: () => Date;
  bodyTimeoutMs?: number; // for tests
}

export interface Handler {
  fetch(request: Request, server?: Pick<Server<unknown>, "timeout">): Promise<Response>;
}

function number(value: string | undefined, fallback: number): number {
  return value === undefined || value.trim() === "" ? fallback : Number(value);
}

export function configFromEnv(env: Record<string, string | undefined>): ProxyConfig {
  const allowedModels = (env.ALLOWED_MODELS?.trim() || DEFAULT_ALLOWED_MODELS)
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  const dailyCapUsd = number(env.DAILY_CAP_USD, 20);
  const maxConcurrent = number(env.MAX_CONCURRENT, 4);
  if (!Number.isFinite(dailyCapUsd) || dailyCapUsd < 0)
    throw new Error("DAILY_CAP_USD must be a number >= 0");
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)
    throw new Error("MAX_CONCURRENT must be an integer >= 1");
  return {
    keyFile: env.ANTHROPIC_API_KEY_FILE?.trim() || DEFAULT_KEY_FILE,
    allowedModels,
    dailyCapUsd,
    spendFile: env.SPEND_FILE?.trim() || DEFAULT_SPEND_FILE,
    maxConcurrent,
  };
}

// The Anthropic API error shape, so the Claude CLI and SDKs report it as-is.
export function apiError(
  status: number,
  type: string,
  message: string,
  headers?: HeadersInit,
): Response {
  return Response.json({ type: "error", error: { type, message } }, { status, headers });
}

// Read on every use, so a rotated Secret takes effect without a restart. A
// value with spaces or control characters is treated as missing (it could not
// be sent as a header anyway). The value itself never leaves this function
// except as the outgoing x-api-key header.
function readKey(file: string): string | undefined {
  try {
    const key = readFileSync(file, "utf8").trim();
    return /^[\x21-\x7e]+$/.test(key) ? key : undefined;
  } catch {
    return undefined;
  }
}

type BodyResult =
  | { body: Uint8Array<ArrayBuffer> }
  | { error: "too-large" | "timeout" | "unreadable" };

// The whole body, at most MAX_BODY_BYTES, within timeoutMs.
async function readBody(request: Request, timeoutMs: number): Promise<BodyResult> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    request.body?.cancel().catch(() => {});
    return { error: "too-large" };
  }
  const reader = request.body?.getReader();
  if (!reader) return { body: new Uint8Array(0) };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result === "timeout") {
        reader.cancel().catch(() => {});
        return { error: "timeout" };
      }
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        reader.cancel().catch(() => {});
        return { error: "too-large" };
      }
      chunks.push(result.value);
    }
  } catch {
    return { error: "unreadable" };
  } finally {
    clearTimeout(timer);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }
  return { body };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A request field that would change the price, which the cap does not model.
// anthropic-beta headers are not checked; these fields are what a beta needs.
function priceChangingField(body: Record<string, unknown>): string | undefined {
  for (const key of ["speed", "fallbacks", "mcp_servers"])
    if (Object.hasOwn(body, key)) return `\`${key}\``;
  if (Object.hasOwn(body, "inference_geo") && body.inference_geo !== "global")
    return '`inference_geo` other than "global"';
  if (Array.isArray(body.tools))
    for (const tool of body.tools) {
      if (!isObject(tool)) continue;
      if (Object.hasOwn(tool, "model")) return "a tool with its own `model`";
      const type = typeof tool.type === "string" ? tool.type : "";
      if (type.startsWith("advisor_") || type === "mcp_toolset")
        return `the \`${type.slice(0, 60)}\` tool`;
    }
  return undefined;
}

// A model name safe to put in a log line; anything else is replaced.
function loggable(model: unknown): string | null {
  if (typeof model !== "string") return null;
  return /^[A-Za-z0-9][A-Za-z0-9.:@_-]{0,99}$/.test(model) ? model : "(invalid)";
}

function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

function dollars(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

// What admission hands to the upstream call.
interface Admitted {
  body: Uint8Array<ArrayBuffer>;
  key: string;
  model: string | undefined; // validated for /v1/messages
  logModel: string | null;
  estimate: number; // reserved until the request finishes; 0 for count_tokens
}

export function createHandler(upstream: string, options: HandlerOptions): Handler {
  const base = new URL(upstream);
  const allowed = new Set(options.allowedModels);
  if (allowed.size === 0) throw new Error("no allowed models");
  for (const model of allowed)
    if (!hasPrice(model))
      throw new Error(`no price for allowed model ${model}; add it to src/prices.ts`);
  const log: Logger = options.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const now = options.now ?? (() => new Date());
  const bodyTimeoutMs = options.bodyTimeoutMs ?? BODY_TIMEOUT_MS;
  const ledger = new SpendLedger(options.spendFile, log, now);
  let inFlight = 0;

  function refuse(
    path: string,
    status: number,
    reason: string,
    response: Response,
    model?: unknown,
  ): Response {
    log({
      time: now().toISOString(),
      event: "refused",
      path,
      model: loggable(model),
      status,
      reason,
    });
    return response;
  }

  function capReached(path: string, day: string, detail: string): Response {
    // No "model:" in this text: the CLI reads that as a refused model and
    // switches to another one.
    return refuse(
      path,
      403,
      "daily-cap",
      apiError(
        403,
        "permission_error",
        `The proxy's estimated daily spending cap of ${dollars(options.dailyCapUsd)} for ${day} ` +
          `(UTC) does not allow this request. ${detail}`,
        NO_RETRY,
      ),
    );
  }

  // Everything checked before the upstream call. Returns the refusal, or what
  // to send. The caller holds a concurrency slot throughout.
  async function admit(request: Request, path: string): Promise<Response | Admitted> {
    const charged = path === MESSAGES;
    if (charged) {
      const spend = ledger.current();
      if (spend.spentUsd + ledger.reserved() >= options.dailyCapUsd) {
        request.body?.cancel().catch(() => {});
        return capReached(path, spend.day, "New requests are refused until 00:00 UTC.");
      }
    }

    const read = await readBody(request, bodyTimeoutMs);
    if ("error" in read) {
      if (read.error === "too-large")
        return refuse(
          path,
          413,
          "body-too-large",
          apiError(
            413,
            "request_too_large",
            `Request body exceeds ${MAX_BODY_BYTES} bytes.`,
            NO_RETRY,
          ),
        );
      if (read.error === "timeout")
        return refuse(
          path,
          408,
          "body-timeout",
          apiError(
            408,
            "invalid_request_error",
            `The request body did not arrive within ${bodyTimeoutMs / 1000} seconds.`,
          ),
        );
      return refuse(
        path,
        400,
        "body-unreadable",
        apiError(400, "invalid_request_error", "The request body could not be read.", NO_RETRY),
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.body));
    } catch {
      parsed = undefined;
    }
    const model = isObject(parsed) ? parsed.model : undefined;
    // Send the parsed JSON, not the caller's bytes: with a duplicated key such
    // as "model", JSON.parse keeps the last value, and the upstream must see
    // exactly the value that was checked.
    const body = isObject(parsed) ? new TextEncoder().encode(JSON.stringify(parsed)) : read.body;

    if (charged) {
      if (!isObject(parsed))
        return refuse(
          path,
          400,
          "invalid-json",
          apiError(400, "invalid_request_error", "Request body must be a JSON object.", NO_RETRY),
        );
      if (typeof model !== "string" || !allowed.has(model)) {
        const shown = typeof model === "string" ? JSON.stringify(model.slice(0, 100)) : "(missing)";
        return refuse(
          path,
          400,
          "model-not-allowed",
          apiError(
            400,
            "invalid_request_error",
            `model ${shown} is not allowed by this proxy. Allowed models: ${[...allowed].join(", ")}.`,
            NO_RETRY,
          ),
          model,
        );
      }
      const field = priceChangingField(parsed);
      if (field)
        return refuse(
          path,
          400,
          "price-changing-field",
          apiError(
            400,
            "invalid_request_error",
            `${field} is not allowed through this proxy: it changes the price, and the ` +
              `proxy's spending cap does not account for it.`,
            NO_RETRY,
          ),
          model,
        );
    }

    const key = readKey(options.keyFile);
    if (!key)
      return refuse(
        path,
        503,
        "no-key",
        apiError(503, "api_error", "The proxy has no API key configured.", NO_RETRY),
        model,
      );

    let estimate = 0;
    if (charged && typeof model === "string" && isObject(parsed)) {
      const maxTokens =
        typeof parsed.max_tokens === "number" &&
        Number.isFinite(parsed.max_tokens) &&
        parsed.max_tokens > 0
          ? parsed.max_tokens
          : DEFAULT_MAX_TOKENS;
      estimate = estimateUsd(model, body.byteLength, maxTokens);
      const spend = ledger.current();
      const reserved = ledger.reserved();
      if (spend.spentUsd + reserved + estimate > options.dailyCapUsd)
        return capReached(
          path,
          spend.day,
          `This request could cost up to ${dollars(estimate)}; ${dollars(spend.spentUsd)} is ` +
            `spent and ${dollars(reserved)} is held by requests in progress. Send a smaller ` +
            `request, or wait for requests in progress or for 00:00 UTC.`,
        );
      ledger.reserve(estimate);
    }

    return {
      body,
      key,
      model: typeof model === "string" ? model : undefined,
      logModel: typeof model === "string" && allowed.has(model) ? model : loggable(model),
      estimate,
    };
  }

  async function send(
    request: Request,
    path: string,
    server: Pick<Server<unknown>, "timeout"> | undefined,
    admitted: Admitted,
    releaseSlot: () => void,
  ): Promise<Response> {
    const charged = path === MESSAGES;
    const { model, logModel, estimate } = admitted;
    // The body is in; from here a long non-streaming request sends nothing
    // until it is done, so the 75 s idle timeout must not apply.
    server?.timeout(request, 0);

    const headers = new Headers();
    for (const name of REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set("x-api-key", admitted.key);

    // Fixed path on the fixed upstream; the caller's query string is dropped.
    // A charged request is not tied to the caller's connection: if the
    // caller leaves, the upstream still runs and bills, so the proxy reads it
    // to the end to record the usage.
    const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(new URL(path, base), {
        method: "POST",
        headers,
        body: admitted.body,
        redirect: "error", // never resend the key to another host
        signal: charged ? timeout : AbortSignal.any([request.signal, timeout]),
      });
    } catch (error) {
      releaseSlot();
      if (charged) ledger.release(estimate);
      // Only the error class: an error message can carry request details.
      const name = error instanceof Error ? error.name : "unknown";
      log({
        time: now().toISOString(),
        event: "upstream-failed",
        path,
        model: logModel,
        status: 502,
        error: name,
      });
      return apiError(502, "api_error", "The proxy could not reach the Anthropic API.", {
        connection: "close",
      });
    }

    const status = upstreamResponse.status;
    const requestId = upstreamResponse.headers.get("request-id");
    const tracker = charged
      ? new UsageTracker(upstreamResponse.headers.get("content-type"))
      : undefined;
    const responseHeaders = new Headers({ connection: "close" });
    for (const name of RESPONSE_HEADERS) {
      const value = upstreamResponse.headers.get(name);
      if (value !== null) responseHeaders.set(name, value);
    }

    let finished = false;
    // Runs once: at the end of the upstream body (whether or not the caller
    // stayed), or when the upstream body fails.
    const finish = (outcome: "complete" | "client-closed" | "upstream-error") => {
      if (finished) return;
      finished = true;
      releaseSlot();
      try {
        let billing: Billing | undefined;
        let cost = 0;
        let charge = "none";
        let dayTotal: number;
        if (charged) {
          billing = tracker?.finish();
          if (billing && model) {
            cost = costUsd(model, billing);
            charge = "usage";
          } else if (status < 400) {
            // Fail closed: a success without readable usage costs the estimate.
            cost = estimate;
            charge = "estimate";
          }
          ledger.release(estimate);
          dayTotal = ledger.charge(cost).spentUsd;
        } else dayTotal = ledger.current().spentUsd;
        const usage = billing?.usage ?? NO_USAGE;
        log({
          time: now().toISOString(),
          event: "forwarded",
          path,
          model: logModel,
          status,
          outcome,
          stream: tracker?.streaming ?? false,
          ...(charged ? { charge, estimatedMaxUsd: round(estimate) } : {}),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheWrite5mTokens: usage.cacheWrite5mTokens,
          cacheWrite1hTokens: usage.cacheWrite1hTokens,
          cacheReadTokens: usage.cacheReadTokens,
          webSearchRequests: usage.webSearchRequests,
          ...(billing?.speed ? { speed: billing.speed } : {}),
          ...(billing?.inferenceGeo ? { inferenceGeo: billing.inferenceGeo } : {}),
          ...(billing?.iterations.length ? { iterations: billing.iterations.length } : {}),
          ...(billing?.unrecognised.length ? { unrecognised: billing.unrecognised } : {}),
          costUsd: round(cost),
          dayTotalUsd: round(dayTotal),
          requestId,
        });
      } catch {
        log({ time: now().toISOString(), event: "accounting-failed", path, requestId });
      }
    };

    const reader = upstreamResponse.body?.getReader();
    if (!reader) {
      finish("complete");
      return new Response(null, { status, headers: responseHeaders });
    }

    // Every chunk goes through readNext, which feeds the tracker once.
    const readNext = async () => {
      const result = await reader.read();
      if (!result.done) tracker?.push(result.value);
      return result;
    };
    let inProgress: ReturnType<typeof readNext> | undefined;
    // After the caller leaves: a charged request reads the upstream to the
    // end and discards it; count_tokens is free, so it is cancelled.
    let detached = false;
    const drain = async () => {
      try {
        if (inProgress && (await inProgress).done) return finish("client-closed");
        while (!(await readNext()).done);
        finish("client-closed");
      } catch {
        finish("upstream-error");
      }
    };
    const detach = () => {
      if (detached || finished) return;
      detached = true;
      if (charged) void drain();
      else {
        finish("client-closed");
        reader.cancel().catch(() => {});
      }
    };
    // Covers a caller that left before the upstream headers arrived, and one
    // that leaves while nothing is reading the stream.
    request.signal.addEventListener("abort", detach, { once: true });
    if (request.signal.aborted) detach();

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (detached) return controller.close();
        let result: Awaited<ReturnType<typeof readNext>>;
        try {
          inProgress = readNext();
          result = await inProgress;
        } catch {
          if (!detached) {
            finish("upstream-error");
            controller.error(new Error("upstream body failed"));
          }
          return;
        } finally {
          inProgress = undefined;
        }
        if (detached) return;
        if (result.done) {
          finish("complete");
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      },
      cancel() {
        detach();
      },
    });
    return new Response(stream, { status, headers: responseHeaders });
  }

  async function forward(
    request: Request,
    path: string,
    server?: Pick<Server<unknown>, "timeout">,
  ): Promise<Response> {
    // The slot is taken before the body is read, so slow or large uploads
    // count against MAX_CONCURRENT too.
    if (inFlight >= options.maxConcurrent) {
      request.body?.cancel().catch(() => {});
      return refuse(
        path,
        429,
        "concurrency",
        apiError(
          429,
          "rate_limit_error",
          `The proxy allows ${options.maxConcurrent} requests at a time. Retry later.`,
          { "retry-after": "5" },
        ),
      );
    }
    inFlight++;
    let held = true;
    const releaseSlot = () => {
      if (held) {
        held = false;
        inFlight--;
      }
    };
    try {
      const admitted = await admit(request, path);
      if (admitted instanceof Response) {
        releaseSlot();
        return admitted;
      }
      return await send(request, path, server, admitted, releaseSlot);
    } catch (error) {
      releaseSlot();
      throw error;
    }
  }

  return {
    async fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/healthz")
        return readKey(options.keyFile)
          ? Response.json({ ok: true })
          : Response.json({ ok: false }, { status: 503 });
      if (request.method === "GET" && path === "/usage") {
        const spend = ledger.current();
        return Response.json({
          day: spend.day,
          spentUsd: round(spend.spentUsd),
          reservedUsd: round(ledger.reserved()),
          capUsd: options.dailyCapUsd,
          requests: spend.requests,
        });
      }
      if (request.method === "POST" && (path === MESSAGES || path === COUNT_TOKENS))
        return forward(request, path, server);
      // Logged so that an endpoint the CLI needs, but the proxy does not
      // forward, shows up. Method and path only, never the body.
      log({
        time: now().toISOString(),
        event: "refused",
        method: request.method,
        path: path.slice(0, 200),
        status: 404,
        reason: "not-proxied",
      });
      return apiError(404, "not_found_error", "Not found.");
    },
  };
}
