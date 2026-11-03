import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromEnv, createHandler, type HandlerOptions } from "./proxy.ts";

// Dummy values only. Neither is, or looks like, a real Anthropic key.
const KEY = "test-proxy-key-not-real";
const CALLER_KEY = "caller-key-must-be-dropped";
const NOW = new Date("2026-11-03T12:00:00Z");

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
  const bytes = new TextEncoder().encode(SSE_BODY);
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

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://proxy.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const message = (model = "claude-opus-5-5", extra: Record<string, unknown> = {}) => ({
  model,
  max_tokens: 1024,
  messages: [{ role: "user", content: "the prompt text" }],
  ...extra,
});

async function usage(h: ReturnType<typeof handler>) {
  return (await h.fetch(new Request("http://proxy.test/usage"))).json();
}

function forwardedLogs() {
  return logs.map((line) => JSON.parse(line)).filter((entry) => entry.event === "forwarded");
}

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

describe("forwarding", () => {
  test("rewrites credentials and passes only the allowed headers both ways", async () => {
    const body = JSON.stringify(message());
    const response = await handler().fetch(
      post("/v1/messages", body, {
        "x-api-key": CALLER_KEY,
        authorization: `Bearer ${CALLER_KEY}`,
        cookie: "session=caller",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "some-beta-2026-01-01",
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
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("anthropic-organization-id")).toBeNull();

    expect(seen).toHaveLength(1);
    const forwarded = seen[0]!;
    expect(forwarded.method).toBe("POST");
    expect(forwarded.path).toBe("/v1/messages");
    expect(forwarded.body).toBe(body);
    expect(forwarded.headers["x-api-key"]).toBe(KEY);
    expect(forwarded.headers.authorization).toBeUndefined();
    expect(forwarded.headers.cookie).toBeUndefined();
    expect(forwarded.headers["x-stainless-retry-count"]).toBeUndefined();
    expect(forwarded.headers["anthropic-version"]).toBe("2023-06-01");
    expect(forwarded.headers["anthropic-beta"]).toBe("some-beta-2026-01-01");
    expect(forwarded.headers["user-agent"]).toBe("claude-cli/test");
    expect(forwarded.headers.accept).toBe("application/json");
    expect(forwarded.headers["content-type"]).toBe("application/json");
    expect(JSON.stringify(forwarded.headers)).not.toContain(CALLER_KEY);
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

  test("forwards count_tokens without charging it", async () => {
    reply = () => Response.json({ input_tokens: 123 }, { headers: { "request-id": "req_count" } });
    const h = handler();
    const response = await h.fetch(
      post("/v1/messages/count_tokens?x=1", message("claude-sonnet-5-5")),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ input_tokens: 123 });
    expect(seen[0]?.path).toBe("/v1/messages/count_tokens");
    expect(seen[0]?.search).toBe("");
    expect(await usage(h)).toEqual({ day: "2026-11-03", spentUsd: 0, capUsd: 20, requests: 0 });
    expect(forwardedLogs()[0]).toMatchObject({
      path: "/v1/messages/count_tokens",
      status: 200,
      costUsd: 0,
    });
  });

  test("passes upstream errors through unchanged", async () => {
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
    expect(await usage(h)).toMatchObject({ spentUsd: 0, requests: 1 });
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
    ]) {
      const response = await h.fetch(request);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        type: "error",
        error: { type: "not_found_error" },
      });
    }
    expect(seen).toHaveLength(0);
    expect(logs.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ event: "refused", method: "GET", path: "/v1/models", status: 404 }),
    );
  });

  test("returns 502 in the error shape when upstream cannot be reached", async () => {
    const h = handler({ maxConcurrent: 1 }, "http://127.0.0.1:1");
    for (let i = 0; i < 2; i++) {
      // A second 502 rather than a 429 shows the slot was released.
      const response = await h.fetch(post("/v1/messages", message()));
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
    }
    expect(await usage(h)).toMatchObject({ requests: 0 });
    expect(logs.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ event: "upstream-failed", status: 502 }),
    );
  });
});

describe("model allowlist", () => {
  test("refuses a model that is not allowed, with the Anthropic error shape", async () => {
    const response = await handler().fetch(post("/v1/messages", message("claude-fable-5-1")));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    expect(body.error.message).toContain("claude-fable-5-1");
    expect(seen).toHaveLength(0);
  });

  test("refuses a missing model and a body that is not JSON", async () => {
    const h = handler();
    for (const body of [{ max_tokens: 1, messages: [] }, "{not json", "[]", { model: 5 }]) {
      const response = await h.fetch(post("/v1/messages", body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        type: "error",
        error: { type: "invalid_request_error" },
      });
    }
    expect(seen).toHaveLength(0);
  });

  test("refuses a body over 32 MB", async () => {
    const response = await handler().fetch(
      new Request("http://proxy.test/v1/messages", {
        method: "POST",
        body: new Uint8Array(32 * 1024 * 1024 + 1),
      }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: { type: "request_too_large" },
    });
    expect(seen).toHaveLength(0);
  });

  test("startup fails for an allowed model without a price", () => {
    expect(() => handler({ allowedModels: ["claude-sonnet-5-5"] })).toThrow("no price");
  });
});

describe("usage and cost", () => {
  test("counts a non-streaming response", async () => {
    const h = handler();
    const response = await h.fetch(post("/v1/messages", message()));
    await response.text();
    const spend = await usage(h);
    expect(spend.requests).toBe(1);
    expect(spend.spentUsd).toBeCloseTo(JSON_COST, 9);
    const [entry] = forwardedLogs();
    expect(entry).toMatchObject({
      path: "/v1/messages",
      model: "claude-opus-5-5",
      status: 200,
      stream: false,
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
    expect(await response.text()).toBe(SSE_BODY);
    const spend = await usage(h);
    expect(spend.spentUsd).toBeCloseTo(SSE_COST, 9);
    expect(forwardedLogs()[0]).toMatchObject({
      model: "claude-haiku-5-5",
      stream: true,
      inputTokens: 2000,
      outputTokens: 40,
      cacheWrite5mTokens: 1000,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 3000,
      webSearchRequests: 1,
      requestId: "req_sse",
    });
  });

  test("a caller that disconnects mid-stream is still charged and frees its slot", async () => {
    // Upstream sends message_start, then stalls as if the model were thinking.
    const head = SSE_BODY.slice(0, SSE_BODY.indexOf("event: content_block_start"));
    let upstreamCancelled = false;
    reply = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(head));
          },
          cancel() {
            upstreamCancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const h = handler({ maxConcurrent: 1 });
    const response = await h.fetch(
      post("/v1/messages", message("claude-haiku-5-5", { stream: true })),
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (text !== head) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    expect(text).toBe(head);
    await reader.cancel();
    await waitFor(() => upstreamCancelled);
    const [entry] = forwardedLogs();
    expect(entry).toMatchObject({
      outcome: "client-closed",
      inputTokens: 2000,
      cacheReadTokens: 3000,
    });
    expect((await usage(h)).requests).toBe(1);

    reply = jsonReply;
    const next = await h.fetch(post("/v1/messages", message()));
    expect(next.status).toBe(200);
    await next.text();
  });
});

describe("daily cap", () => {
  test("lets an in-flight request pass the cap, then refuses with 403 and no upstream call", async () => {
    const h = handler({ dailyCapUsd: 0.05 });
    await (await h.fetch(post("/v1/messages", message()))).text(); // $0.0558, over the cap
    expect(seen).toHaveLength(1);

    const refused = await h.fetch(post("/v1/messages", message()));
    expect(refused.status).toBe(403);
    const body = await refused.json();
    expect(body).toMatchObject({ type: "error", error: { type: "permission_error" } });
    expect(body.error.message).toContain("$0.05");
    expect(seen).toHaveLength(1);

    // count_tokens is neither charged nor blocked.
    reply = () => Response.json({ input_tokens: 5 });
    expect((await h.fetch(post("/v1/messages/count_tokens", message()))).status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(await usage(h)).toMatchObject({ capUsd: 0.05, requests: 1 });
  });

  test("a new UTC day starts from zero", async () => {
    let now = new Date("2026-11-03T23:59:00Z");
    const h = handler({ dailyCapUsd: 0.05, now: () => now });
    await (await h.fetch(post("/v1/messages", message()))).text();
    expect((await h.fetch(post("/v1/messages", message()))).status).toBe(403);
    now = new Date("2026-11-04T00:00:01Z");
    expect(await usage(h)).toEqual({ day: "2026-11-04", spentUsd: 0, capUsd: 0.05, requests: 0 });
    const response = await h.fetch(post("/v1/messages", message()));
    expect(response.status).toBe(200);
    await response.text();
  });
});

describe("persistence", () => {
  test("a new handler on the same spend file keeps today's total", async () => {
    const first = handler();
    await (await first.fetch(post("/v1/messages", message()))).text();
    const second = handler();
    const spend = await usage(second);
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
      expect(await usage(handler())).toEqual({
        day: "2026-11-03",
        spentUsd: 0,
        capUsd: 20,
        requests: 0,
      });
      expect(logs.map((line) => JSON.parse(line))).toContainEqual(
        expect.objectContaining({ event: "spend-file-ignored", reason: "corrupt" }),
      );
    }
  });
});

describe("concurrency", () => {
  test("answers 429 with retry-after beyond MAX_CONCURRENT, and frees the slot afterwards", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    reply = async () => {
      await gate;
      return jsonReply();
    };
    const h = handler({ maxConcurrent: 1 });
    const first = h.fetch(post("/v1/messages", message()));
    await waitFor(() => seen.length === 1);

    const refused = await h.fetch(post("/v1/messages", message()));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("5");
    expect(await refused.json()).toMatchObject({
      type: "error",
      error: { type: "rate_limit_error" },
    });
    expect(seen).toHaveLength(1);

    release();
    await (await first).text();
    reply = jsonReply;
    const after = await h.fetch(post("/v1/messages", message()));
    expect(after.status).toBe(200);
    await after.text();
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
    expect(
      (
        await handler({ keyFile: join(dir, "empty") }).fetch(
          new Request("http://proxy.test/healthz"),
        )
      ).status,
    ).toBe(503);
  });

  test("without a key nothing is forwarded", async () => {
    const response = await handler({ keyFile: join(dir, "missing") }).fetch(
      post("/v1/messages", message()),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
    expect(seen).toHaveLength(0);
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
    const h = handler({ dailyCapUsd: 0.05, maxConcurrent: 1 });
    await collect(h.fetch(post("/v1/messages", message(), { "x-api-key": KEY })));
    reply = () => sseReply();
    await collect(h.fetch(post("/v1/messages/count_tokens", message())));
    await collect(h.fetch(post("/v1/messages", message("not-allowed"))));
    await collect(h.fetch(post("/v1/messages", message())));
    await collect(h.fetch(post("/v1/messages", "{bad json")));
    await collect(h.fetch(new Request("http://proxy.test/v1/models")));
    await collect(h.fetch(new Request("http://proxy.test/healthz")));
    await collect(h.fetch(new Request("http://proxy.test/usage")));
    await collect(handler({}, "http://127.0.0.1:1").fetch(post("/v1/messages", message())));
    await collect(
      handler({ keyFile: join(dir, "missing") }).fetch(post("/v1/messages", message())),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    reply = async () => {
      await gate;
      return jsonReply();
    };
    const busy = handler({ maxConcurrent: 1 });
    const pending = busy.fetch(post("/v1/messages", message()));
    await waitFor(() => seen.length === 3);
    await collect(busy.fetch(post("/v1/messages", message())));
    release();
    await (await pending).text();

    const proxyErrors = bodies.filter((b) => b.includes('"type":"error"'));
    expect(proxyErrors.length).toBeGreaterThanOrEqual(5);
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
