// USD per million tokens, used only to enforce the proxy's daily cap.
//
// These are ESTIMATES copied from Anthropic's public price list. The Anthropic
// Console (Usage and Cost pages) is the real record of what was billed. The
// table does not model fast mode, batch discounts, data-residency multipliers
// or any other modifier; a request that uses one is priced at standard rates.
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
}

export const WEB_SEARCH_USD_PER_REQUEST = 0.01;

// Above this total input (uncached input + cache writes + cache reads), Haiku
// uses its long-context prices.
export const HAIKU_LONG_CONTEXT_THRESHOLD = 100_000;

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

export function hasPrice(model: string): boolean {
  return Object.hasOwn(PRICES, model);
}

export function totalInputTokens(usage: Usage): number {
  return (
    usage.inputTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens + usage.cacheReadTokens
  );
}

export function ratesFor(model: string, totalInput: number): Rates {
  const price = PRICES[model];
  if (!price) throw new Error(`no price for model ${model}`);
  return price(totalInput);
}

export function costUsd(model: string, usage: Usage): number {
  const r = ratesFor(model, totalInputTokens(usage));
  const tokens =
    usage.inputTokens * r.input +
    usage.outputTokens * r.output +
    usage.cacheReadTokens * r.cacheRead +
    usage.cacheWrite5mTokens * r.cacheWrite5m +
    usage.cacheWrite1hTokens * r.cacheWrite1h;
  return tokens / 1_000_000 + usage.webSearchRequests * WEB_SEARCH_USD_PER_REQUEST;
}
