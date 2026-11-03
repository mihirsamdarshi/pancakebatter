import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateUsd } from "./prices.ts";
import { configFromEnv, createHandler, MAX_BODY_BYTES, type HandlerOptions } from "./proxy.ts";

// Dummy values only. Neither is, or looks like, a real Anthropic key.
const KEY = "test-proxy-key-not-real";
const CALLER_KEY = "caller-key-must-be-dropped";
const NOW = new Date("2026-11-03T12:00:00Z");
const encoder = new TextEncoder();

interface Seen {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: string;
}

let seen: Seen[] = [];
let reply: (request: Request) => Response | Promise<Response>;

const mock = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    seen.push({
      method: request.method,
      path: url.pathname,
      search: url.search,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    });
    return reply(request);
  },
});
const upstream = `http://127.0.0.1:${mock.port}`;
afterAll(() => mock.stop(true));

// Opus: 1000*4 + 500*20 + 4000*0.2 + 1000*5 + 2000*8 = 35,800 per million,
// plus two searches at $0.01.
const JSON_USAGE = {
  input_tokens: 1000,
  output_tokens: 500,
  cache_creation_input_tokens: 3000,
  cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
  cache_read_input_tokens: 4000,
  server_tool_use: { web_search_requests: 2 },
};
const JSON_COST = 0.0358 + 0.02;
const JSON_BODY = JSON.stringify({
  id: "msg_json",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: "the response text" }],
  stop_reason: "end_turn",
  usage: JSON_USAGE,
});

// Haiku, short tier: 2000*0.1 + 40*0.5 + 3000*0.01 + 1000*0.125 = 375 per
// million, plus one search.
const SSE_COST = 0.000375 + 0.01;
const SSE_BODY = [
  "event: message_start",
  'data: {"type":"message_start","message":{"id":"msg_sse","type":"message","role":"assistant","model":"claude-haiku-5-5",' +
    '"content":[],"usage":{"input_tokens":2000,"cache_creation_input_tokens":1000,"cache_read_input_tokens":3000,' +
    '"cache_creation":{"ephemeral_5m_input_tokens":1000,"ephemeral_1h_input_tokens":0},"output_tokens":1}}}',
  "",
  "event: content_block_start",
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  "",
  "event: ping",
  'data: {"type": "ping"}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"the streamed text"}}',
  "",
  "event: content_block_stop",
  'data: {"type":"content_block_stop","index":0}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},' +
    '"usage":{"input_tokens":2000,"cache_creation_input_tokens":1000,"cache_read_input_tokens":3000,"output_tokens":40,' +
    '"server_tool_use":{"web_search_requests":1}}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
  "",
].join("\n");
const SSE_HEAD = SSE_BODY.slice(0, SSE_BODY.indexOf("event: content_block_start"));

function jsonReply(): Response {
  return new Response(JSON_BODY, {
    headers: {
      "content-type": "application/json",
      "request-id": "req_json",
      "set-cookie": "session=upstream; Path=/",
      "anthropic-organization-id": "org-should-not-pass",
    },
  });
}

function sseReply(chunkSize = 13): Response {
  const bytes = encoder.encode(SSE_BODY);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
      await Bun.sleep(0);
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "request-id": "req_sse" },
  });
}

// Sends message_start, then waits for `gate` before sending the rest.
function gatedSseReply(gate: Promise<void>, onCancel: () => void): Response {
  let sentHead = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentHead) {
        sentHead = true;
        controller.enqueue(encoder.encode(SSE_HEAD));
        return;
      }
      await gate;
      controller.enqueue(encoder.encode(SSE_BODY.slice(SSE_HEAD.length)));
      controller.close();
    },
    cancel: onCancel,
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "request-id": "req_sse" },
  });
}

function makeGate() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

let dir: string;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-proxy-test-"));
  writeFileSync(join(dir, "anthropic-api-key"), `${KEY}\n`);
  seen = [];
  logs = [];
  reply = jsonReply;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function handler(overrides: Partial<HandlerOptions> = {}, target = upstream) {
  return createHandler(target, {
    keyFile: join(dir, "anthropic-api-key"),
    allowedModels: ["claude-opus-5-5", "claude-haiku-5-5"],
    dailyCapUsd: 20,
    spendFile: join(dir, "spend.json"),
    maxConcurrent: 4,
    log: (entry) => logs.push(JSON.stringify(entry)),
    now: () => NOW,
    ...overrides,
  });
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) {
  return new Request(`http://proxy.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });
}

// A request whose body is a stream the test controls.
function postStream(path: string, body: ReadableStream<Uint8Array>, headers = {}) {
  return new Request(`http://proxy.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    duplex: "half",
  } as RequestInit);
}

const message = (model = "claude-opus-5-5", extra: Record<string, unknown> = {}) => ({
  model,
  max_tokens: 1024,
  messages: [{ role: "user", content: "the prompt text" }],
  ...extra,
});

// The reservation the proxy makes for message(model, extra).
function estimateOf(model = "claude-opus-5-5", extra: Record<string, unknown> = {}) {
  const body = message(model, extra);
  return estimateUsd(model, encoder.encode(JSON.stringify(body)).byteLength, body.max_tokens);
}

async function usage(h: ReturnType<typeof handler>) {
  return (await h.fetch(new Request("http://proxy.test/usage"))).json();
}

function entries() {
  return logs.map((line) => JSON.parse(line));
}

function forwardedLogs() {
  return entries().filter((entry) => entry.event === "forwarded");
}

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

async function expectError(response: Response, status: number, type: string, retry?: "false") {
  expect(response.status).toBe(status);
  expect(response.headers.get("x-should-retry")).toBe(retry ?? null);
  const body = await response.json();
  expect(body).toMatchObject({ type: "error", error: { type } });
  return body.error.message as string;
}

describe("forwarding", () => {
  test("rewrites credentials and passes only the allowed headers both ways", async () => {
    const response = await handler().fetch(
      post("/v1/messages", message(), {
        "x-api-key": CALLER_KEY,
        authorization: `Bearer ${CALLER_KEY}`,
        cookie: "session=caller",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "beta-one-2026-01-01,beta-two-2026-02-01",
        "user-agent": "claude-cli/test",
        accept: "application/json",
        connection: "keep-alive",
        "x-stainless-retry-count": "0",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON_BODY);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("request-id")).toBe("req_json");
    expect(response.headers.get("connection")).toBe("close");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("anthropic-organization-id")).toBeNull();

    expect(seen).toHaveLength(1);
    const forwarded = seen[0]!;
    expect(forwarded.method).toBe("POST");
    expect(forwarded.path).toBe("/v1/messages");
    expect(JSON.parse(forwarded.body)).toEqual(message());
    expect(forwarded.headers["x-api-key"]).toBe(KEY);
    expect(forwarded.headers.authorization).toBeUndefined();
    expect(forwarded.headers.cookie).toBeUndefined();
    expect(forwarded.headers["x-stainless-retry-count"]).toBeUndefined();
    expect(forwarded.headers["anthropic-version"]).toBe("2023-06-01");
    expect(forwarded.headers["anthropic-beta"]).toBe("beta-one-2026-01-01,beta-two-2026-02-01");
    expect(forwarded.headers["user-agent"]).toBe("claude-cli/test");
    expect(forwarded.headers.accept).toBe("application/json");
    expect(forwarded.headers["content-type"]).toBe("application/json");
    expect(JSON.stringify(forwarded.headers)).not.toContain(CALLER_KEY);
  });

  test("forwards the parsed JSON, so a duplicated model key cannot run another model", async () => {
    const h = handler();
    const rest = '"max_tokens":5,"messages":[{"role":"user","content":"hi"}]';
    // JSON.parse keeps the last key: this one is checked as Opus...
    const response = await h.fetch(
      post("/v1/messages", `{"model":"claude-fable-5-1","model":"claude-opus-5-5",${rest}}`),
    );
    expect(response.status).toBe(200);
    await response.text();
    // ...and the upstream sees only Opus.
    expect(seen[0]?.body).toBe(
      JSON.stringify({
        model: "claude-opus-5-5",
        max_tokens: 5,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(seen[0]?.body).not.toContain("claude-fable-5-1");
    // The other order is checked as Fable and refused.
    await expectError(
      await h.fetch(
        post("/v1/messages", `{"model":"claude-opus-5-5","model":"claude-fable-5-1",${rest}}`),
      ),
      400,
      "invalid_request_error",
      "false",
    );
    expect(seen).toHaveLength(1);
  });

  test("drops the query string", async () => {
    const response = await handler().fetch(
      post("/v1/messages?beta=true&redirect=https://example.com", message()),
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(seen[0]?.path).toBe("/v1/messages");
    expect(seen[0]?.search).toBe("");
  });

  test("forwards count_tokens without charging or checking it", async () => {
    reply = () => Response.json({ input_tokens: 123 }, { headers: { "request-id": "req_count" } });
    const h = handler({ dailyCapUsd: 0 });
    const response = await h.fetch(
      post("/v1/messages/count_tokens?x=1", message("claude-sonnet-5-5", { speed: "fast" })),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ input_tokens: 123 });
    expect(seen[0]?.path).toBe("/v1/messages/count_tokens");
    expect(seen[0]?.search).toBe("");
    expect(await usage(h)).toEqual({
      day: "2026-11-03",
      spentUsd: 0,
      reservedUsd: 0,
      capUsd: 0,
      requests: 0,
    });
    expect(forwardedLogs()[0]).toMatchObject({
      path: "/v1/messages/count_tokens",
      status: 200,
      costUsd: 0,
    });
  });

  test("passes upstream errors through unchanged and charges nothing for them", async () => {
    const error = JSON.stringify({
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
    });
    reply = () =>
      new Response(error, {
        status: 529,
        headers: {
          "content-type": "application/json",
          "request-id": "req_err",
          "x-should-retry": "true",
        },
      });
    const h = handler();
    const response = await h.fetch(post("/v1/messages", message()));
    expect(response.status).toBe(529);
    expect(response.headers.get("x-should-retry")).toBe("true");
    expect(await response.text()).toBe(error);
    expect(await usage(h)).toMatchObject({ spentUsd: 0, reservedUsd: 0, requests: 1 });
    expect(forwardedLogs()[0]).toMatchObject({ charge: "none", costUsd: 0 });
  });

  test("answers 404 for every other path and method, without calling upstream", async () => {
    const h = handler();
    for (const request of [
      new Request("http://proxy.test/v1/models"),
      post("/v1/models", {}),
      post("/v1/messages/batches", message()),
      post("/v1/messages/", message()),
      post("/v1/complete", message()),
      new Request("http://proxy.test/v1/messages"),
      new Request("http://proxy.test/healthz", { method: "POST" }),
      post("/v1/files", {}),
    ])
      await expectError(await h.fetch(request), 404, "not_found_error");
    expect(seen).toHaveLength(0);
    expect(entries()).toContainEqual(
      expect.objectContaining({ event: "refused", method: "GET", path: "/v1/models", status: 404 }),
    );
  });

  test("returns 502 when upstream cannot be reached, and releases the slot and reservation", async () => {
    const h = handler({ maxConcurrent: 1 }, "http://127.0.0.1:1");
    for (let i = 0; i < 2; i++) {
      // A second 502 rather than a 429 shows the slot was released.
      const response = await h.fetch(post("/v1/messages", message()));
      expect(response.headers.get("connection")).toBe("close");
      await expectError(response, 502, "api_error");
    }
    expect(await usage(h)).toMatchObject({ requests: 0, reservedUsd: 0 });
    expect(entries()).toContainEqual(
      expect.objectContaining({ event: "upstream-failed", status: 502 }),
    );
  });
});

describe("request checks", () => {
  test("refuses a model that is not allowed, without a retry", async () => {
    const text = await expectError(
      await handler().fetch(post("/v1/messages", message("claude-fable-5-1"))),
      400,
      "invalid_request_error",
      "false",
    );
    expect(text).toContain("claude-fable-5-1");
    expect(seen).toHaveLength(0);
  });

  test("refuses a missing model and a body that is not a JSON object", async () => {
    const h = handler();
    for (const body of [{ max_tokens: 1, messages: [] }, "{not json", "[]", { model: 5 }])
      await expectError(
        await h.fetch(post("/v1/messages", body)),
        400,
        "invalid_request_error",
        "false",
      );
    expect(seen).toHaveLength(0);
  });

  test("refuses request fields that change the price", async () => {
    const h = handler();
    const refused: Record<string, unknown>[] = [
      { speed: "fast" },
      { speed: "standard" },
      { fallbacks: "default" },
      { fallbacks: [{ model: "claude-opus-4-8" }] },
      { mcp_servers: [] },
      { inference_geo: "us" },
      { inference_geo: null },
      { tools: [{ type: "advisor_20260301", name: "advisor", model: "claude-opus-5-5" }] },
      { tools: [{ type: "advisor_20260301", name: "advisor" }] },
      { tools: [{ name: "mine", input_schema: { type: "object" }, model: "claude-haiku-5-5" }] },
      { tools: [{ type: "mcp_toolset", mcp_server_name: "server" }] },
    ];
    for (const extra of refused) {
      const text = await expectError(
        await h.fetch(post("/v1/messages", message("claude-opus-5-5", extra))),
        400,
        "invalid_request_error",
        "false",
      );
      expect(text).toContain("changes the price");
    }
    expect(seen).toHaveLength(0);
    expect(entries().filter((e) => e.reason === "price-changing-field")).toHaveLength(
      refused.length,
    );
  });

  test("allows global inference, ordinary tools and any anthropic-beta header", async () => {
    const h = handler();
    const extra = {
      inference_geo: "global",
      tools: [
        { type: "web_search_20260209", name: "web_search" },
        { name: "mine", input_schema: { type: "object" } },
      ],
    };
    const response = await h.fetch(
      post("/v1/messages", message("claude-opus-5-5", extra), {
        "anthropic-beta": "fast-mode-2026-02-01,mcp-client-2025-11-20",
      }),
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(seen[0]?.headers["anthropic-beta"]).toBe("fast-mode-2026-02-01,mcp-client-2025-11-20");
  });

  test("refuses a body over 16 MB while reading it", async () => {
    const response = await handler().fetch(
      new Request("http://proxy.test/v1/messages", {
        method: "POST",
        body: new Uint8Array(MAX_BODY_BYTES + 1),
      }),
    );
    expect(MAX_BODY_BYTES).toBe(16 * 1024 * 1024);
    await expectError(response, 413, "request_too_large", "false");
    expect(seen).toHaveLength(0);
  });

  test("refuses a declared content-length over 16 MB before reading anything", async () => {
    let pulls = 0;
    // This body never delivers a byte: only the content-length check can
    // answer before the 60 s body deadline.
    const stalled = new ReadableStream<Uint8Array>({
      pull() {
        pulls++;
        return new Promise(() => {});
      },
    });
    const response = await handler().fetch(
      postStream("/v1/messages", stalled, { "content-length": String(MAX_BODY_BYTES + 1) }),
    );
    await expectError(response, 413, "request_too_large", "false");
    expect(pulls).toBeLessThanOrEqual(1);
    expect(seen).toHaveLength(0);
  });

  test("startup fails for an allowed model without a price", () => {
    expect(() => handler({ allowedModels: ["claude-sonnet-5-5"] })).toThrow("no price");
  });
});

describe("slots and slow callers", () => {
  test("the slot is taken before the body is read", async () => {
    const { gate, open } = makeGate();
    const bytes = encoder.encode(JSON.stringify(message()));
    let sent = false;
    const slowBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(bytes.slice(0, 10));
          return;
        }
        await gate;
        controller.enqueue(bytes.slice(10));
        controller.close();
      },
    });
    const h = handler({ maxConcurrent: 1 });
    const first = h.fetch(postStream("/v1/messages", slowBody));
    await Bun.sleep(20);
    const refused = await h.fetch(post("/v1/messages", message()));
    expect(refused.headers.get("retry-after")).toBe("5");
    await expectError(refused, 429, "rate_limit_error");
    open();
    const response = await first;
    expect(response.status).toBe(200);
    await response.text();
    expect(seen).toHaveLength(1);
  });

  test("a body that does not arrive within the deadline is refused and frees the slot", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {});
      },
    });
    const h = handler({ maxConcurrent: 1, bodyTimeoutMs: 50 });
    const started = Date.now();
    await expectError(
      await h.fetch(postStream("/v1/messages", stalled)),
      408,
      "invalid_request_error",
    );
    expect(Date.now() - started).toBeLessThan(2000);
    const next = await h.fetch(post("/v1/messages", message()));
    expect(next.status).toBe(200);
    await next.text();
  });

  test("the idle timeout is turned off only after the body is read", async () => {
    const calls: { seconds: number; bodyRead: boolean }[] = [];
    let bodyRead = false;
    const server = { timeout: (_: Request, seconds: number) => calls.push({ seconds, bodyRead }) };
    const bytes = encoder.encode(JSON.stringify(message()));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      },
      async pull(controller) {
        await Bun.sleep(10);
        bodyRead = true;
        controller.close();
      },
    });
    const h = handler();
    const response = await h.fetch(postStream("/v1/messages", body), server);
    await response.text();
    expect(calls).toEqual([{ seconds: 0, bodyRead: true }]);

    // A refused request never turns it off.
    await h.fetch(post("/v1/messages", message("claude-fable-5-1")), server);
    await h.fetch(
      postStream("/v1/messages", new ReadableStream(), { "content-length": "999999999" }),
      server,
    );
    expect(calls).toHaveLength(1);
  });

  test("answers 429 with retry-after beyond MAX_CONCURRENT, and frees the slot afterwards", async () => {
    const { gate, open } = makeGate();
    reply = async () => {
      await gate;
      return jsonReply();
    };
    const h = handler({ maxConcurrent: 1 });
    const first = h.fetch(post("/v1/messages", message()));
    await waitFor(() => seen.length === 1);

    const refused = await h.fetch(post("/v1/messages", message()));
    expect(refused.headers.get("retry-after")).toBe("5");
    await expectError(refused, 429, "rate_limit_error");
    expect(seen).toHaveLength(1);

    open();
    await (await first).text();
    reply = jsonReply;
    const after = await h.fetch(post("/v1/messages", message()));
    expect(after.status).toBe(200);
    await after.text();
  });
});

describe("usage and cost", () => {
  test("counts a non-streaming response", async () => {
    const h = handler();
    const response = await h.fetch(post("/v1/messages", message()));
    await response.text();
    const spend = await usage(h);
    expect(spend.requests).toBe(1);
    expect(spend.reservedUsd).toBe(0);
    expect(spend.spentUsd).toBeCloseTo(JSON_COST, 9);
    const [entry] = forwardedLogs();
    expect(entry).toMatchObject({
      path: "/v1/messages",
      model: "claude-opus-5-5",
      status: 200,
      stream: false,
      charge: "usage",
      inputTokens: 1000,
      outputTokens: 500,
      cacheWrite5mTokens: 1000,
      cacheWrite1hTokens: 2000,
      cacheReadTokens: 4000,
      webSearchRequests: 2,
      requestId: "req_json",
    });
    expect(entry.costUsd).toBeCloseTo(JSON_COST, 6);
    expect(entry.dayTotalUsd).toBeCloseTo(JSON_COST, 6);
    expect(entry.estimatedMaxUsd).toBeCloseTo(estimateOf(), 6);
    expect(typeof entry.time).toBe("string");
  });

  test("streams SSE through unchanged and counts it", async () => {
    reply = () => sseReply(13);
    const h = handler();
    const response = await h.fetch(
      post("/v1/messages", message("claude-haiku-5-5", { stream: true })),
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("request-id")).toBe("req_sse");
    expect(response.headers.get("connection")).toBe("close");
    expect(await response.text()).toBe(SSE_BODY);
    expect((await usage(h)).spentUsd).toBeCloseTo(SSE_COST, 9);
    expect(forwardedLogs()[0]).toMatchObject({
      model: "claude-haiku-5-5",
      stream: true,
      charge: "usage",
      inputTokens: 2000,
      outputTokens: 40,
      cacheWrite5mTokens: 1000,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 3000,
      webSearchRequests: 1,
      requestId: "req_sse",
    });
  });

  test("reads usage from the end of a large JSON response", async () => {
    const big = JSON.stringify({
      type: "message",
      content: [{ type: "text", text: "w".repeat(2 * 1024 * 1024) }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    reply = () => new Response(big, { headers: { "content-type": "application/json" } });
    const h = handler();
    const response = await h.fetch(post("/v1/messages", message()));
    expect((await response.text()).length).toBe(big.length);
    expect((await usage(h)).spentUsd).toBeCloseTo((100 * 4 + 50 * 20) / 1e6, 12);
  });

  test("a success without usage is charged the estimate (JSON and SSE)", async () => {
    for (const body of [
      new Response('{"type":"message","content":[]}', {
        headers: { "content-type": "application/json" },
      }),
      new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
      new Response("not json", { headers: { "content-type": "text/plain" } }),
    ]) {
      logs = [];
      rmSync(join(dir, "spend.json"), { force: true });
      reply = () => body;
      const h = handler();
      await (await h.fetch(post("/v1/messages", message()))).text();
      expect((await usage(h)).spentUsd).toBeCloseTo(estimateOf(), 6);
      expect(forwardedLogs()[0]).toMatchObject({ charge: "estimate" });
    }
  });

  test("response usage reporting fast mode or US inference is priced up", async () => {
    reply = () =>
      Response.json({
        type: "message",
        usage: { input_tokens: 1000, output_tokens: 500, speed: "fast", inference_geo: "us" },
      });
    const h = handler();
    await (await h.fetch(post("/v1/messages", message()))).text();
    expect((await usage(h)).spentUsd).toBeCloseTo(((1000 * 4 + 500 * 20) / 1e6) * 2 * 1.1, 9);
    expect(forwardedLogs()[0]).toMatchObject({ speed: "fast", inferenceGeo: "us" });
  });
});

describe("client disconnects", () => {
  test("a caller that leaves mid-stream: the upstream is read to the end and fully charged", async () => {
    const { gate, open } = makeGate();
    let upstreamCancelled = false;
    reply = () => gatedSseReply(gate, () => (upstreamCancelled = true));
    const h = handler({ maxConcurrent: 1 });
    const response = await h.fetch(
      post("/v1/messages", message("claude-haiku-5-5", { stream: true })),
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (text !== SSE_HEAD) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();
    open();
    await waitFor(() => forwardedLogs().length === 1);
    expect(forwardedLogs()[0]).toMatchObject({
      outcome: "client-closed",
      charge: "usage",
      outputTokens: 40,
      webSearchRequests: 1,
    });
    expect(upstreamCancelled).toBe(false);
    expect((await usage(h)).spentUsd).toBeCloseTo(SSE_COST, 9);

    reply = jsonReply;
    const next = await h.fetch(post("/v1/messages", message()));
    expect(next.status).toBe(200);
    await next.text();
  });

  test("a caller that leaves before the upstream headers arrive is still charged", async () => {
    const { gate, open } = makeGate();
    reply = async () => {
      await gate;
      return jsonReply();
    };
    const h = handler({ maxConcurrent: 1 });
    const caller = new AbortController();
    const pending = h.fetch(post("/v1/messages", message(), {}, caller.signal));
    await waitFor(() => seen.length === 1);
    caller.abort();
    open();
    await pending; // nobody reads this response
    await waitFor(() => forwardedLogs().length === 1);
    expect(forwardedLogs()[0]).toMatchObject({ outcome: "client-closed", charge: "usage" });
    expect(await usage(h)).toMatchObject({ requests: 1, reservedUsd: 0 });
    expect((await usage(h)).spentUsd).toBeCloseTo(JSON_COST, 9);
    const next = await h.fetch(post("/v1/messages", message()));
    expect(next.status).toBe(200);
    await next.text();
  });

  test("through a real server, a disconnect mid-stream is drained and charged", async () => {
    const { gate, open } = makeGate();
    let upstreamCancelled = false;
    reply = () => gatedSseReply(gate, () => (upstreamCancelled = true));
    const h = handler();
    const proxy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: h.fetch });
    try {
      const caller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message("claude-haiku-5-5", { stream: true })),
        signal: caller.signal,
      });
      expect(response.headers.get("connection")).toBe("close");
      await response.body!.getReader().read();
      caller.abort();
      await Bun.sleep(50);
      open();
      await waitFor(() => forwardedLogs().length === 1);
      expect(forwardedLogs()[0]).toMatchObject({ outcome: "client-closed", outputTokens: 40 });
      expect(upstreamCancelled).toBe(false);
      expect((await usage(h)).spentUsd).toBeCloseTo(SSE_COST, 9);
    } finally {
      await proxy.stop(true);
    }
  });
});

describe("daily cap and reservations", () => {
  test("concurrent in-flight requests may pass the cap; later ones get 403 and no upstream call", async () => {
    const { gate, open } = makeGate();
    reply = async () => {
      await gate;
      return jsonReply();
    };
    // Each request reserves about $0.0206, so both fit under $0.05; each then
    // costs $0.0558.
    const h = handler({ dailyCapUsd: 0.05 });
    const first = h.fetch(post("/v1/messages", message()));
    const second = h.fetch(post("/v1/messages", message()));
    await waitFor(() => seen.length === 2);
    expect((await usage(h)).reservedUsd).toBeCloseTo(2 * estimateOf(), 6);
    open();
    await Promise.all([(await first).text(), (await second).text()]);
    expect(await usage(h)).toMatchObject({ reservedUsd: 0, requests: 2 });
    expect((await usage(h)).spentUsd).toBeCloseTo(2 * JSON_COST, 9);

    const message403 = await expectError(
      await h.fetch(post("/v1/messages", message())),
      403,
      "permission_error",
      "false",
    );
    expect(message403).toContain("$0.05");
    expect(message403).not.toContain("model:");
    expect(seen).toHaveLength(2);

    // count_tokens is neither charged nor blocked.
    reply = () => Response.json({ input_tokens: 5 });
    expect((await h.fetch(post("/v1/messages/count_tokens", message()))).status).toBe(200);
    expect(seen).toHaveLength(3);
  });

  test("a request whose estimate does not fit beside the reservations is refused", async () => {
    const { gate, open } = makeGate();
    reply = async () => {
      await gate;
      return Response.json({ type: "message", usage: { input_tokens: 10, output_tokens: 10 } });
    };
    const h = handler({ dailyCapUsd: 0.03 });
    const first = h.fetch(post("/v1/messages", message()));
    await waitFor(() => seen.length === 1);
    const text = await expectError(
      await h.fetch(post("/v1/messages", message())),
      403,
      "permission_error",
      "false",
    );
    expect(text).toContain("held by requests in progress");
    expect(text).not.toContain("model:");
    expect(seen).toHaveLength(1);

    open();
    await (await first).text();
    // Settled at its real cost ($0.00024), the reservation is gone.
    expect((await usage(h)).reservedUsd).toBe(0);
    const third = await h.fetch(post("/v1/messages", message()));
    expect(third.status).toBe(200);
    await third.text();
  });

  test("a single request larger than the cap is refused before it is sent", async () => {
    const h = handler({ dailyCapUsd: 1 });
    // 128,000 output tokens on Opus: $2.56.
    await expectError(
      await h.fetch(post("/v1/messages", message("claude-opus-5-5", { max_tokens: 128_000 }))),
      403,
      "permission_error",
      "false",
    );
    // No max_tokens: the estimate assumes 128,000.
    const { max_tokens: _, ...noMax } = message();
    await expectError(await h.fetch(post("/v1/messages", noMax)), 403, "permission_error", "false");
    expect(seen).toHaveLength(0);
    expect((await usage(h)).reservedUsd).toBe(0);
  });

  test("a new UTC day starts from zero", async () => {
    let now = new Date("2026-11-03T23:59:00Z");
    const h = handler({ dailyCapUsd: 0.05, now: () => now });
    await (await h.fetch(post("/v1/messages", message()))).text();
    expect((await h.fetch(post("/v1/messages", message()))).status).toBe(403);
    now = new Date("2026-11-04T00:00:01Z");
    expect(await usage(h)).toEqual({
      day: "2026-11-04",
      spentUsd: 0,
      reservedUsd: 0,
      capUsd: 0.05,
      requests: 0,
    });
    const response = await h.fetch(post("/v1/messages", message()));
    expect(response.status).toBe(200);
    await response.text();
  });
});

describe("persistence", () => {
  test("a new handler on the same spend file keeps today's total", async () => {
    const first = handler();
    await (await first.fetch(post("/v1/messages", message()))).text();
    const spend = await usage(handler());
    expect(spend.requests).toBe(1);
    expect(spend.spentUsd).toBeCloseTo(JSON_COST, 9);
  });

  test("a spend file from an earlier day is not carried over", async () => {
    writeFileSync(
      join(dir, "spend.json"),
      JSON.stringify({ day: "2026-11-02", spentUsd: 19.5, requests: 80 }),
    );
    expect(await usage(handler())).toEqual({
      day: "2026-11-03",
      spentUsd: 0,
      reservedUsd: 0,
      capUsd: 20,
      requests: 0,
    });
  });

  test("a corrupt spend file is ignored and logged", async () => {
    for (const content of [
      "{",
      JSON.stringify({ day: "2026-11-03", spentUsd: "lots", requests: 1 }),
    ]) {
      logs = [];
      writeFileSync(join(dir, "spend.json"), content);
      expect(await usage(handler())).toMatchObject({ spentUsd: 0, requests: 0 });
      expect(entries()).toContainEqual(
        expect.objectContaining({ event: "spend-file-ignored", reason: "corrupt" }),
      );
    }
  });
});

describe("credential handling", () => {
  test("healthz is 200 with a key file and 503 without one, or with an empty one", async () => {
    expect((await handler().fetch(new Request("http://proxy.test/healthz"))).status).toBe(200);
    const missing = handler({ keyFile: join(dir, "missing") });
    const response = await missing.fetch(new Request("http://proxy.test/healthz"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
    writeFileSync(join(dir, "empty"), " \n");
    const empty = handler({ keyFile: join(dir, "empty") });
    expect((await empty.fetch(new Request("http://proxy.test/healthz"))).status).toBe(503);
  });

  test("without a key nothing is forwarded, and the caller is told not to retry", async () => {
    const h = handler({ keyFile: join(dir, "missing") });
    await expectError(await h.fetch(post("/v1/messages", message())), 503, "api_error", "false");
    expect(seen).toHaveLength(0);
    expect((await usage(h)).reservedUsd).toBe(0);
  });

  test("a rotated key file is used without a restart", async () => {
    const h = handler();
    await (await h.fetch(post("/v1/messages", message()))).text();
    writeFileSync(join(dir, "anthropic-api-key"), "test-proxy-key-rotated\n");
    await (await h.fetch(post("/v1/messages", message()))).text();
    expect(seen.map((s) => s.headers["x-api-key"])).toEqual([KEY, "test-proxy-key-rotated"]);
  });

  test("the key, the prompt and the response text never appear in logs or proxy responses", async () => {
    const bodies: string[] = [];
    const collect = async (response: Response | Promise<Response>) =>
      bodies.push(await (await response).text());
    const h = handler();
    await collect(h.fetch(post("/v1/messages", message(), { "x-api-key": KEY })));
    reply = () => sseReply();
    await collect(h.fetch(post("/v1/messages/count_tokens", message())));
    await collect(h.fetch(post("/v1/messages", message("not-allowed"))));
    await collect(h.fetch(post("/v1/messages", message("claude-opus-5-5", { speed: "fast" }))));
    // 403: the first request already spent more than this cap.
    await collect(handler({ dailyCapUsd: 0.05 }).fetch(post("/v1/messages", message())));
    await collect(h.fetch(post("/v1/messages", "{bad json")));
    await collect(
      h.fetch(
        new Request("http://proxy.test/v1/messages", {
          method: "POST",
          body: new Uint8Array(MAX_BODY_BYTES + 1),
        }),
      ),
    );
    await collect(h.fetch(new Request("http://proxy.test/v1/models")));
    await collect(h.fetch(new Request("http://proxy.test/healthz")));
    await collect(h.fetch(new Request("http://proxy.test/usage")));
    await collect(handler({}, "http://127.0.0.1:1").fetch(post("/v1/messages", message())));
    await collect(
      handler({ keyFile: join(dir, "missing") }).fetch(post("/v1/messages", message())),
    );
    const { gate, open } = makeGate();
    reply = async () => {
      await gate;
      return jsonReply();
    };
    const busy = handler({ maxConcurrent: 1 });
    const pending = busy.fetch(post("/v1/messages", message()));
    await waitFor(() => seen.length === 3);
    await collect(busy.fetch(post("/v1/messages", message()))); // 429
    open();
    await (await pending).text();

    const proxyErrors = bodies.filter((b) => b.includes('"type":"error"'));
    expect(proxyErrors.length).toBeGreaterThanOrEqual(8);
    for (const text of [...bodies, ...logs]) expect(text).not.toContain(KEY);
    for (const line of logs) {
      expect(line).not.toContain("the prompt text");
      expect(line).not.toContain("the response text");
      expect(line).not.toContain("the streamed text");
    }
  });
});

describe("configFromEnv", () => {
  test("defaults", () => {
    expect(configFromEnv({})).toEqual({
      keyFile: "/run/credentials/anthropic-api-key",
      allowedModels: ["claude-opus-5-5", "claude-haiku-5-5"],
      dailyCapUsd: 20,
      spendFile: "/tmp/claude-proxy-spend.json",
      maxConcurrent: 4,
    });
  });

  test("parses and validates values", () => {
    expect(
      configFromEnv({
        ALLOWED_MODELS: " claude-haiku-5-5 , ",
        DAILY_CAP_USD: "2.5",
        MAX_CONCURRENT: "2",
      }),
    ).toMatchObject({ allowedModels: ["claude-haiku-5-5"], dailyCapUsd: 2.5, maxConcurrent: 2 });
    expect(() => configFromEnv({ DAILY_CAP_USD: "twenty" })).toThrow();
    expect(() => configFromEnv({ DAILY_CAP_USD: "-1" })).toThrow();
    expect(() => configFromEnv({ MAX_CONCURRENT: "0" })).toThrow();
    expect(() => configFromEnv({ MAX_CONCURRENT: "1.5" })).toThrow();
  });
});
