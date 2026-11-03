import { describe, expect, test } from "bun:test";
import {
  costUsd,
  estimateUsd,
  hasPrice,
  HIGHEST_RATES,
  NO_USAGE,
  ratesFor,
  type Billing,
  type Usage,
} from "./prices.ts";

function billing(usage: Partial<Usage>, extra: Partial<Billing> = {}): Billing {
  return { usage: { ...NO_USAGE, ...usage }, iterations: [], unrecognised: [], ...extra };
}

describe("prices", () => {
  test("Opus 5.5 uses its own table", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
    };
    expect(costUsd("claude-opus-5-5", billing(usage))).toBeCloseTo(4 + 20 + 0.2 + 5 + 8, 9);
  });

  test("Haiku 5.5 short context derives cache prices from input", () => {
    const usage = {
      inputTokens: 40_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 30_000,
      cacheWrite5mTokens: 20_000,
      cacheWrite1hTokens: 10_000,
    }; // total input 100,000: still the short tier
    const expected =
      (40_000 * 0.1 + 1_000_000 * 0.5 + 30_000 * 0.01 + 20_000 * 0.125 + 10_000 * 0.2) / 1e6;
    expect(costUsd("claude-haiku-5-5", billing(usage))).toBeCloseTo(expected, 12);
  });

  test("Haiku 5.5 above 100,000 total input tokens uses long-context prices", () => {
    const usage = { inputTokens: 10_001, cacheReadTokens: 90_000, outputTokens: 1_000 };
    const expected = (10_001 * 0.5 + 90_000 * 0.05 + 1_000 * 2.5) / 1e6;
    expect(costUsd("claude-haiku-5-5", billing(usage))).toBeCloseTo(expected, 12);
  });

  test("web search is $0.01 per request", () => {
    expect(costUsd("claude-opus-5-5", billing({ webSearchRequests: 3 }))).toBeCloseTo(0.03, 12);
  });

  test("unknown models have no price and are charged at the highest rates", () => {
    expect(hasPrice("claude-opus-5-5")).toBe(true);
    expect(hasPrice("claude-sonnet-5-5")).toBe(false);
    expect(hasPrice("toString")).toBe(false);
    expect(HIGHEST_RATES).toEqual({
      input: 4,
      output: 20,
      cacheRead: 0.2,
      cacheWrite5m: 5,
      cacheWrite1h: 8,
    });
    expect(ratesFor("claude-sonnet-5-5", 0)).toEqual(HIGHEST_RATES);
    expect(ratesFor(undefined, 0)).toEqual(HIGHEST_RATES);
  });
});

describe("defensive pricing", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 100_000 }; // Opus: $4 + $2
  test("fast mode is 2x and US-only inference is 1.1x", () => {
    expect(costUsd("claude-opus-5-5", billing(usage, { speed: "fast" }))).toBeCloseTo(12, 9);
    expect(costUsd("claude-opus-5-5", billing(usage, { inferenceGeo: "us" }))).toBeCloseTo(6.6, 9);
    expect(
      costUsd("claude-opus-5-5", billing(usage, { speed: "fast", inferenceGeo: "us" })),
    ).toBeCloseTo(13.2, 9);
  });

  test("standard, global and not_available change nothing; unknown values take the multiplier", () => {
    for (const extra of [
      { speed: "standard" },
      { inferenceGeo: "global" },
      { inferenceGeo: "not_available" },
    ])
      expect(costUsd("claude-opus-5-5", billing(usage, extra))).toBeCloseTo(6, 9);
    expect(costUsd("claude-opus-5-5", billing(usage, { speed: "turbo" }))).toBeCloseTo(12, 9);
    expect(costUsd("claude-opus-5-5", billing(usage, { inferenceGeo: "eu" }))).toBeCloseTo(6.6, 9);
  });

  test("iterations are added up, each at its own model's price", () => {
    // Top-level usage covers only the last attempt; the attempts are the bill.
    const result = billing(
      { outputTokens: 1_000_000 },
      {
        iterations: [
          { model: "claude-haiku-5-5", usage: { ...NO_USAGE, inputTokens: 1_000_000 } }, // long tier: $0.50
          { usage: { ...NO_USAGE, outputTokens: 1_000_000 } }, // request model, Opus: $20
        ],
      },
    );
    expect(costUsd("claude-opus-5-5", result)).toBeCloseTo(20.5, 9);
  });

  test("an iteration on an unknown model is charged at the highest rates", () => {
    const result = billing(
      {},
      {
        iterations: [{ model: "claude-opus-4-8", usage: { ...NO_USAGE, inputTokens: 1_000_000 } }],
      },
    );
    expect(costUsd("claude-haiku-5-5", result)).toBeCloseTo(4, 9);
  });

  test("the larger of the top-level usage and the iterations is charged", () => {
    const result = billing(
      { outputTokens: 1_000_000 },
      { iterations: [{ usage: { ...NO_USAGE, outputTokens: 10 } }] },
    );
    expect(costUsd("claude-opus-5-5", result)).toBeCloseTo(20, 9);
  });

  test("unknown token fields cost the highest token rate, unknown tool counts $0.01", () => {
    expect(costUsd("claude-haiku-5-5", billing({ otherTokens: 1_000_000 }))).toBeCloseTo(20, 9);
    expect(costUsd("claude-haiku-5-5", billing({ otherRequests: 5 }))).toBeCloseTo(0.05, 12);
  });

  test("the estimate is bytes / 3 of input plus max_tokens of output", () => {
    expect(estimateUsd("claude-opus-5-5", 3_000_000, 100_000)).toBeCloseTo(4 + 2, 9);
    // 300,000 bytes is 100,000 tokens: Haiku's short tier.
    expect(estimateUsd("claude-haiku-5-5", 300_000, 1_000_000)).toBeCloseTo(0.01 + 0.5, 9);
    expect(estimateUsd("claude-haiku-5-5", 300_003, 0)).toBeCloseTo(100_001 * 0.5e-6, 9);
  });
});
