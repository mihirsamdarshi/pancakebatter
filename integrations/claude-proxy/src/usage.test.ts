import { describe, expect, test } from "bun:test";
import { NO_USAGE } from "./prices.ts";
import { billingFromApi, UsageTracker, usageFromTail } from "./usage.ts";

const encoder = new TextEncoder();

function feed(tracker: UsageTracker, text: string, chunkSize: number) {
  const bytes = encoder.encode(text);
  for (let i = 0; i < bytes.length; i += chunkSize) tracker.push(bytes.slice(i, i + chunkSize));
  return tracker.finish();
}

const stream = [
  "event: message_start",
  'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],' +
    '"usage":{"input_tokens":12,"cache_creation_input_tokens":30,"cache_read_input_tokens":40,' +
    '"cache_creation":{"ephemeral_5m_input_tokens":10,"ephemeral_1h_input_tokens":20},"output_tokens":1}}}',
  "",
  "event: ping",
  'data: {"type":"ping"}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"héllo 😀 日本"}}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":null},"usage":{"output_tokens":7,"cache_read_input_tokens":null}}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9,' +
    '"server_tool_use":{"web_search_requests":2}}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
  "",
].join("\n");

const expected = {
  ...NO_USAGE,
  inputTokens: 12,
  outputTokens: 9,
  cacheWrite5mTokens: 10,
  cacheWrite1hTokens: 20,
  cacheReadTokens: 40,
  webSearchRequests: 2,
};

describe("UsageTracker: SSE", () => {
  test("message_delta totals replace earlier values, nulls are ignored", () => {
    expect(
      feed(new UsageTracker("text/event-stream; charset=utf-8"), stream, 1 << 16)?.usage,
    ).toEqual(expected);
  });

  test("events split across arbitrary chunks, including inside UTF-8 sequences", () => {
    for (const size of [1, 2, 3, 7, 64])
      expect(feed(new UsageTracker("text/event-stream"), stream, size)?.usage).toEqual(expected);
  });

  test("CRLF line endings and a missing final blank line", () => {
    const crlf = stream.replace(/\n/g, "\r\n").replace(/(\r\n)+$/, "");
    expect(feed(new UsageTracker("text/event-stream"), crlf, 5)?.usage).toEqual(expected);
  });

  test("malformed and oversized events are skipped without losing the others", () => {
    const huge = "x".repeat(2 * 1024 * 1024);
    const text = [
      "event: message_start",
      "data: {not json",
      "",
      "event: message_delta",
      `data: {"type":"message_delta","usage":{"output_tokens":5},"pad":"${huge}"}`,
      "",
      "event: message_delta",
      'data: {"type":"message_delta","usage":{"output_tokens":3}}',
      "",
    ].join("\n");
    expect(feed(new UsageTracker("text/event-stream"), text, 4096)?.usage.outputTokens).toBe(3);
  });

  test("a stream cut off after message_start still reports input usage", () => {
    const cut = stream.slice(0, stream.indexOf("event: content_block_delta"));
    expect(feed(new UsageTracker("text/event-stream"), cut, 10)?.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 1,
    });
  });

  test("speed, inference_geo and iterations from message_delta", () => {
    const text = [
      "event: message_start",
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","usage":{"output_tokens":8,"speed":"fast","inference_geo":"us",' +
        '"iterations":[{"type":"message","input_tokens":5,"output_tokens":8}]}}',
      "",
    ].join("\n");
    const billing = feed(new UsageTracker("text/event-stream"), text, 9);
    expect(billing).toMatchObject({ speed: "fast", inferenceGeo: "us" });
    expect(billing?.iterations).toEqual([
      { model: undefined, usage: { ...NO_USAGE, inputTokens: 5, outputTokens: 8 } },
    ]);
  });
});

describe("UsageTracker: JSON", () => {
  test("a small response uses its top-level usage", () => {
    const body = JSON.stringify({ type: "message", usage: { input_tokens: 3, output_tokens: 4 } });
    expect(feed(new UsageTracker("application/json"), body, 3)?.usage).toMatchObject({
      inputTokens: 3,
      outputTokens: 4,
    });
  });

  test("a large response is read from its tail, past a nested usage key in the content", () => {
    const body = JSON.stringify({
      id: "msg_big",
      type: "message",
      content: [
        // A tool input with its own "usage" key, and text with braces and quotes.
        { type: "tool_use", id: "t", name: "x", input: { usage: { input_tokens: 999_999 } } },
        {
          type: "text",
          text: `{"usage":{"input_tokens":1}} \\"usage\\": ${"y".repeat(3_000_000)}`,
        },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 70, output_tokens: 80, cache_read_input_tokens: 90 },
      context_management: null,
    });
    expect(body.length).toBeGreaterThan(1024 * 1024);
    const billing = feed(new UsageTracker("application/json"), body, 64 * 1024);
    expect(billing?.usage).toMatchObject({
      inputTokens: 70,
      outputTokens: 80,
      cacheReadTokens: 90,
    });
  });

  test("responses without usage report none", () => {
    const error = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "bad" },
    });
    expect(feed(new UsageTracker("application/json"), error, 100)).toBeUndefined();
    expect(feed(new UsageTracker("text/plain"), "hello", 100)).toBeUndefined();
    const big = JSON.stringify({ type: "message", content: "z".repeat(600_000) });
    expect(feed(new UsageTracker("application/json"), big, 8192)).toBeUndefined();
  });
});

describe("usageFromTail", () => {
  test("takes the last usage object, ignoring braces inside strings", () => {
    const text = 'xt": "a}b{c"}],"usage":{"input_tokens":1,"note":"}{","output_tokens":2},"z":1}';
    expect(usageFromTail(text)).toEqual({ input_tokens: 1, note: "}{", output_tokens: 2 });
  });

  test("returns nothing when the object is cut off or holds no token counts", () => {
    expect(usageFromTail('"usage":{"input_tokens":1')).toBeUndefined();
    expect(usageFromTail('"usage":{"other":1}')).toBeUndefined();
    expect(usageFromTail("")).toBeUndefined();
  });
});

describe("billingFromApi", () => {
  test("cache writes without a TTL split count as 5-minute writes", () => {
    expect(billingFromApi({ cache_creation_input_tokens: 50 }).usage).toMatchObject({
      cacheWrite5mTokens: 50,
      cacheWrite1hTokens: 0,
    });
    expect(
      billingFromApi({
        cache_creation_input_tokens: 50,
        cache_creation: { ephemeral_1h_input_tokens: 20 },
      }).usage,
    ).toMatchObject({ cacheWrite5mTokens: 30, cacheWrite1hTokens: 20 });
  });

  test("unrecognised numeric fields are counted and named", () => {
    const billing = billingFromApi({
      input_tokens: 1,
      output_tokens: 2,
      thinking_tokens: 100,
      cache_creation_input_tokens: 70,
      cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_24h_input_tokens: 60 },
      server_tool_use: { web_search_requests: 1, web_fetch_requests: 3 },
      service_tier: "standard",
      something_requests: 4,
      widgets: 7,
    });
    expect(billing.usage).toMatchObject({
      cacheWrite5mTokens: 10,
      otherTokens: 160,
      webSearchRequests: 1,
      otherRequests: 7,
    });
    expect(billing.unrecognised.sort()).toEqual(
      [
        "thinking_tokens",
        "cache_creation.ephemeral_24h_input_tokens",
        "server_tool_use.web_fetch_requests",
        "something_requests",
        "widgets",
      ].sort(),
    );
  });

  test("iterations keep their own model", () => {
    const billing = billingFromApi({
      input_tokens: 1,
      iterations: [
        { type: "message", input_tokens: 3 },
        { type: "fallback_message", model: "claude-opus-4-8", output_tokens: 4 },
        "not an object",
      ],
    });
    expect(billing.iterations).toEqual([
      { model: undefined, usage: { ...NO_USAGE, inputTokens: 3 } },
      { model: "claude-opus-4-8", usage: { ...NO_USAGE, outputTokens: 4 } },
    ]);
  });
});
