import { describe, expect, test } from "bun:test";
import { UsageTracker, usageFromApi } from "./usage.ts";

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
  inputTokens: 12,
  outputTokens: 9,
  cacheWrite5mTokens: 10,
  cacheWrite1hTokens: 20,
  cacheReadTokens: 40,
  webSearchRequests: 2,
};

describe("UsageTracker", () => {
  test("SSE usage: message_delta totals replace earlier values, nulls are ignored", () => {
    expect(feed(new UsageTracker("text/event-stream; charset=utf-8"), stream, 1 << 16)).toEqual(
      expected,
    );
  });

  test("SSE events split across arbitrary chunks, including inside UTF-8 sequences", () => {
    for (const size of [1, 2, 3, 7, 64])
      expect(feed(new UsageTracker("text/event-stream"), stream, size)).toEqual(expected);
  });

  test("CRLF line endings and a missing final blank line", () => {
    const crlf = stream.replace(/\n/g, "\r\n").replace(/(\r\n)+$/, "");
    expect(feed(new UsageTracker("text/event-stream"), crlf, 5)).toEqual(expected);
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
    expect(feed(new UsageTracker("text/event-stream"), text, 4096)?.outputTokens).toBe(3);
  });

  test("a stream cut off after message_start still reports input usage", () => {
    const cut = stream.slice(0, stream.indexOf("event: content_block_delta"));
    expect(feed(new UsageTracker("text/event-stream"), cut, 10)).toMatchObject({
      inputTokens: 12,
      outputTokens: 1,
    });
  });

  test("JSON responses use the top-level usage", () => {
    const body = JSON.stringify({ type: "message", usage: { input_tokens: 3, output_tokens: 4 } });
    expect(feed(new UsageTracker("application/json"), body, 3)).toMatchObject({
      inputTokens: 3,
      outputTokens: 4,
    });
  });

  test("responses without usage report none", () => {
    const error = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "bad" },
    });
    expect(feed(new UsageTracker("application/json"), error, 100)).toBeUndefined();
    expect(feed(new UsageTracker("text/plain"), "hello", 100)).toBeUndefined();
  });

  test("cache writes without a TTL split count as 5-minute writes", () => {
    expect(usageFromApi({ cache_creation_input_tokens: 50 })).toMatchObject({
      cacheWrite5mTokens: 50,
      cacheWrite1hTokens: 0,
    });
    expect(
      usageFromApi({
        cache_creation_input_tokens: 50,
        cache_creation: { ephemeral_1h_input_tokens: 20 },
      }),
    ).toMatchObject({ cacheWrite5mTokens: 30, cacheWrite1hTokens: 20 });
  });
});
