import { readFileSync } from "node:fs";
import type { Server } from "bun";
import { costUsd, hasPrice, type Usage } from "./prices.ts";
import { SpendLedger, type Logger } from "./spend.ts";
import { UsageTracker } from "./usage.ts";

export const MAX_BODY_BYTES = 32 * 1024 * 1024;
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
}

export interface Handler {
  fetch(request: Request, server?: Server<unknown>): Promise<Response>;
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

async function readBody(request: Request): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    await request.body?.cancel().catch(() => {});
    return undefined;
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }
  return body;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A model name safe to put in a log line; anything else is replaced.
function loggable(model: unknown): string | null {
  if (typeof model !== "string") return null;
  return /^[A-Za-z0-9][A-Za-z0-9.:@_-]{0,99}$/.test(model) ? model : "(invalid)";
}

function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
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

  async function forward(
    request: Request,
    path: string,
    server?: Server<unknown>,
  ): Promise<Response> {
    const charged = path === MESSAGES;
    // The 75 s idle timeout is for idle keep-alive connections. A long
    // non-streaming request sends nothing until it is done.
    server?.timeout(request, 0);

    if (charged) {
      const spend = ledger.current();
      if (spend.spentUsd >= options.dailyCapUsd) {
        await request.body?.cancel().catch(() => {});
        return refuse(
          path,
          403,
          "daily-cap",
          apiError(
            403,
            "permission_error",
            `The proxy's daily spending cap of $${options.dailyCapUsd.toFixed(2)} (estimated) is reached for ` +
              `${spend.day} UTC. New requests are refused until 00:00 UTC.`,
          ),
        );
      }
    }

    const body = await readBody(request);
    if (!body)
      return refuse(
        path,
        413,
        "body-too-large",
        apiError(413, "request_too_large", `Request body exceeds ${MAX_BODY_BYTES} bytes.`),
      );

    let model: unknown;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      model = isObject(parsed) ? parsed.model : undefined;
    } catch {
      if (charged)
        return refuse(
          path,
          400,
          "invalid-json",
          apiError(400, "invalid_request_error", "Request body must be a JSON object."),
        );
    }
    if (charged && (typeof model !== "string" || !allowed.has(model))) {
      const shown = typeof model === "string" ? JSON.stringify(model.slice(0, 100)) : "(missing)";
      return refuse(
        path,
        400,
        "model-not-allowed",
        apiError(
          400,
          "invalid_request_error",
          `model ${shown} is not allowed by this proxy. Allowed models: ${[...allowed].join(", ")}.`,
        ),
        model,
      );
    }
    const logModel = typeof model === "string" && allowed.has(model) ? model : loggable(model);

    const key = readKey(options.keyFile);
    if (!key)
      return refuse(
        path,
        503,
        "no-key",
        apiError(503, "api_error", "The proxy has no API key configured."),
        model,
      );

    if (inFlight >= options.maxConcurrent)
      return refuse(
        path,
        429,
        "concurrency",
        apiError(
          429,
          "rate_limit_error",
          `The proxy allows ${options.maxConcurrent} concurrent upstream requests. Retry later.`,
          { "retry-after": "5" },
        ),
        model,
      );
    inFlight++;

    const headers = new Headers();
    for (const name of REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set("x-api-key", key);

    // Fixed path on the fixed upstream; the caller's query string is dropped.
    const target = new URL(path, base);
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(target, {
        method: "POST",
        headers,
        body,
        redirect: "error", // never resend the key to another host
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
      });
    } catch (error) {
      inFlight--;
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
      return apiError(502, "api_error", "The proxy could not reach the Anthropic API.");
    }

    const status = upstreamResponse.status;
    const requestId = upstreamResponse.headers.get("request-id");
    const tracker = charged
      ? new UsageTracker(upstreamResponse.headers.get("content-type"))
      : undefined;
    const responseHeaders = new Headers();
    for (const name of RESPONSE_HEADERS) {
      const value = upstreamResponse.headers.get(name);
      if (value !== null) responseHeaders.set(name, value);
    }

    let finished = false;
    // Runs once: at the end of the body, when the caller disconnects, or when
    // the upstream body fails. Usage seen so far is charged in every case.
    const finish = (outcome: "complete" | "client-closed" | "upstream-error") => {
      if (finished) return;
      finished = true;
      inFlight--;
      try {
        let usage: Usage | undefined;
        let cost = 0;
        let dayTotal: number;
        if (tracker) {
          usage = tracker.finish();
          if (usage && typeof model === "string") cost = costUsd(model, usage);
          dayTotal = ledger.charge(cost).spentUsd;
        } else dayTotal = ledger.current().spentUsd;
        log({
          time: now().toISOString(),
          event: "forwarded",
          path,
          model: logModel,
          status,
          outcome,
          stream: tracker?.streaming ?? false,
          ...(tracker ? { usageFound: usage !== undefined } : {}),
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          cacheWrite5mTokens: usage?.cacheWrite5mTokens ?? 0,
          cacheWrite1hTokens: usage?.cacheWrite1hTokens ?? 0,
          cacheReadTokens: usage?.cacheReadTokens ?? 0,
          webSearchRequests: usage?.webSearchRequests ?? 0,
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
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          finish("upstream-error");
          controller.error(new Error("upstream body failed"));
          return;
        }
        if (chunk.done) {
          finish("complete");
          controller.close();
          return;
        }
        tracker?.push(chunk.value);
        controller.enqueue(chunk.value);
      },
      async cancel() {
        finish("client-closed");
        await reader.cancel().catch(() => {});
      },
    });
    return new Response(stream, { status, headers: responseHeaders });
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
