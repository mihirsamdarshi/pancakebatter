import { describe, expect, test } from "bun:test";
import { costUsd, hasPrice, type Usage } from "./prices.ts";

const none: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
  webSearchRequests: 0,
};

describe("prices", () => {
  test("Opus 5.5 uses its own table", () => {
    const usage = {
      ...none,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
    };
    expect(costUsd("claude-opus-5-5", usage)).toBeCloseTo(4 + 20 + 0.2 + 5 + 8, 9);
  });

  test("Haiku 5.5 short context derives cache prices from input", () => {
    const usage = {
      ...none,
      inputTokens: 40_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 30_000,
      cacheWrite5mTokens: 20_000,
      cacheWrite1hTokens: 10_000,
    }; // total input 100,000: still the short tier
    const expected =
      (40_000 * 0.1 + 1_000_000 * 0.5 + 30_000 * 0.01 + 20_000 * 0.125 + 10_000 * 0.2) / 1e6;
    expect(costUsd("claude-haiku-5-5", usage)).toBeCloseTo(expected, 12);
  });

  test("Haiku 5.5 above 100,000 total input tokens uses long-context prices", () => {
    const usage = { ...none, inputTokens: 10_001, cacheReadTokens: 90_000, outputTokens: 1_000 };
    const expected = (10_001 * 0.5 + 90_000 * 0.05 + 1_000 * 2.5) / 1e6;
    expect(costUsd("claude-haiku-5-5", usage)).toBeCloseTo(expected, 12);
  });

  test("web search is $0.01 per request", () => {
    expect(costUsd("claude-opus-5-5", { ...none, webSearchRequests: 3 })).toBeCloseTo(0.03, 12);
  });

  test("unknown models have no price", () => {
    expect(hasPrice("claude-opus-5-5")).toBe(true);
    expect(hasPrice("claude-sonnet-5-5")).toBe(false);
    expect(hasPrice("toString")).toBe(false);
    expect(() => costUsd("claude-sonnet-5-5", none)).toThrow();
  });
});
