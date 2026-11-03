// USD per million tokens, used only to enforce the proxy's daily cap.
//
// These are ESTIMATES copied from Anthropic's public price list. The Anthropic
// Console (Usage and Cost pages) is the real record of what was billed.
//
// The proxy refuses the request fields that change the price (fast mode,
// server-side fallbacks, MCP servers, regional inference, advisor tools). If
// a response still reports one, or reports a model or a usage field this table
// does not know, it is priced high rather than low:
// - `speed` other than "standard": 2x (the fast-mode price);
// - `inference_geo` other than "global" (or "not_available"): 1.1x (the US
//   price);
// - a model without a row here: the highest rate of each kind in the table;
// - an unknown `*_tokens` field: the highest per-token rate in the table;
// - an unknown server tool count: the web search price per request.
// A multiplier applies to the whole cost, web search fees included, which
// slightly overstates it.
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
  webSearchRequests: number;
  // Fields this table does not know, charged at the highest rates.
  otherTokens: number;
  otherRequests: number;
}

// Everything a response reports about its cost.
export interface Billing {
  usage: Usage;
  speed?: string;
  inferenceGeo?: string;
  // `usage.iterations`: one entry per attempt (fallbacks, compaction). When
  // present, the top-level usage covers only the last attempt.
  iterations: { model?: string; usage: Usage }[];
  // Names of usage fields that were not recognised, for the log.
  unrecognised: string[];
}

export const WEB_SEARCH_USD_PER_REQUEST = 0.01;
export const FAST_MULTIPLIER = 2;
export const REGIONAL_MULTIPLIER = 1.1;

// Above this total input (uncached input + cache writes + cache reads), Haiku
// uses its long-context prices.
export const HAIKU_LONG_CONTEXT_THRESHOLD = 100_000;

// For the cost estimate made before a request is sent: request bytes per
// input token (an overestimate for text), and the output budget used when a
// request gives no max_tokens.
export const BYTES_PER_TOKEN = 3;
export const DEFAULT_MAX_TOKENS = 128_000;

export const NO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
  webSearchRequests: 0,
  otherTokens: 0,
  otherRequests: 0,
};

function fromInput(input: number, output: number): Rates {
  return {
    input,
    output,
    cacheRead: input * 0.1,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
  };
}

const PRICES: Record<string, (totalInputTokens: number) => Rates> = {
  "claude-opus-5-5": () => ({
    input: 4.0,
    output: 20.0,
    cacheRead: 0.2,
    cacheWrite5m: 5.0,
    cacheWrite1h: 8.0,
  }),
  "claude-haiku-5-5": (totalInput) =>
    totalInput <= HAIKU_LONG_CONTEXT_THRESHOLD ? fromInput(0.1, 0.5) : fromInput(0.5, 2.5),
};

// The highest rate of each kind, over every model and price tier.
export const HIGHEST_RATES: Rates = (() => {
  const highest = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  for (const price of Object.values(PRICES))
    for (const totalInput of [0, Number.POSITIVE_INFINITY]) {
      const rates = price(totalInput);
      for (const key of Object.keys(highest) as (keyof Rates)[])
        highest[key] = Math.max(highest[key], rates[key]);
    }
  return highest;
})();
const HIGHEST_TOKEN_RATE = Math.max(...Object.values(HIGHEST_RATES));

export function hasPrice(model: string): boolean {
  return Object.hasOwn(PRICES, model);
}

export function totalInputTokens(usage: Usage): number {
  return (
    usage.inputTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens + usage.cacheReadTokens
  );
}

export function ratesFor(model: string | undefined, totalInput: number): Rates {
  const price = model !== undefined && hasPrice(model) ? PRICES[model] : undefined;
  return price ? price(totalInput) : HIGHEST_RATES;
}

export function priceMultiplier(speed?: string, inferenceGeo?: string): number {
  let multiplier = 1;
  if (speed !== undefined && speed !== "standard") multiplier *= FAST_MULTIPLIER;
  if (inferenceGeo !== undefined && inferenceGeo !== "global" && inferenceGeo !== "not_available")
    multiplier *= REGIONAL_MULTIPLIER;
  return multiplier;
}

function usageCost(model: string | undefined, usage: Usage): number {
  const r = ratesFor(model, totalInputTokens(usage));
  const tokens =
    usage.inputTokens * r.input +
    usage.outputTokens * r.output +
    usage.cacheReadTokens * r.cacheRead +
    usage.cacheWrite5mTokens * r.cacheWrite5m +
    usage.cacheWrite1hTokens * r.cacheWrite1h +
    usage.otherTokens * HIGHEST_TOKEN_RATE;
  return (
    tokens / 1_000_000 +
    (usage.webSearchRequests + usage.otherRequests) * WEB_SEARCH_USD_PER_REQUEST
  );
}

// `model` is the model the request named; an iteration may name another.
export function costUsd(model: string, billing: Billing): number {
  const last = usageCost(model, billing.usage);
  const attempts = billing.iterations.reduce(
    (sum, iteration) => sum + usageCost(iteration.model ?? model, iteration.usage),
    0,
  );
  return Math.max(last, attempts) * priceMultiplier(billing.speed, billing.inferenceGeo);
}

// The most a request is expected to cost, before it is sent: its size in
// tokens at BYTES_PER_TOKEN as uncached input, plus all of max_tokens as output.
export function estimateUsd(model: string, requestBytes: number, maxTokens: number): number {
  const inputTokens = requestBytes / BYTES_PER_TOKEN;
  const r = ratesFor(model, inputTokens);
  return (inputTokens * r.input + maxTokens * r.output) / 1_000_000;
}
