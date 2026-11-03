import { NO_USAGE, type Billing, type Usage } from "./prices.ts";

// Reads token usage from an upstream response while the bytes pass through
// unchanged. Nothing here may throw into the pass-through: a body the tracker
// cannot read is still delivered; the proxy then charges its estimate.

// A JSON response keeps only its last bytes: `usage` is the last large field
// of a Messages response, so the whole body is never buffered.
const JSON_TAIL_BYTES = 256 * 1024;
// One SSE line or event kept for parsing. Usage events are tiny; text and tool
// deltas are skipped by event name before they are buffered.
const MAX_EVENT_BYTES = 1024 * 1024;
const USAGE_EVENTS = new Set(["message_start", "message_delta"]);

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

// Fields with a known meaning, per object. Any other numeric field is
// unrecognised: `*_tokens` is charged at the highest token rate, a server tool
// count at the highest per-request price.
const KNOWN_USAGE = new Set([
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "cache_creation",
  "server_tool_use",
  "iterations",
  "speed",
  "inference_geo",
  "service_tier",
  "type",
  "model",
]);
const KNOWN_CACHE_WRITES = new Set(["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"]);

function usageFields(raw: Json, unrecognised: string[], prefix: string): Usage {
  const usage: Usage = { ...NO_USAGE };
  usage.inputTokens = count(raw.input_tokens);
  usage.outputTokens = count(raw.output_tokens);
  usage.cacheReadTokens = count(raw.cache_read_input_tokens);
  for (const [key, value] of Object.entries(raw)) {
    if (KNOWN_USAGE.has(key) || typeof value !== "number") continue;
    unrecognised.push(prefix + key);
    if (key.endsWith("_tokens")) usage.otherTokens += count(value);
    else if (key.endsWith("_requests")) usage.otherRequests += count(value);
  }

  // Without a `cache_creation` split, every cache write is taken to be a
  // 5-minute write.
  const cacheWriteTotal = count(raw.cache_creation_input_tokens);
  const split = isObject(raw.cache_creation) ? raw.cache_creation : undefined;
  usage.cacheWrite5mTokens = cacheWriteTotal;
  if (split) {
    let unknownWrites = 0;
    for (const [key, value] of Object.entries(split))
      if (!KNOWN_CACHE_WRITES.has(key) && typeof value === "number") {
        unrecognised.push(`${prefix}cache_creation.${key}`);
        if (key.endsWith("_tokens")) unknownWrites += count(value);
      }
    usage.otherTokens += unknownWrites;
    usage.cacheWrite1hTokens = count(split.ephemeral_1h_input_tokens);
    usage.cacheWrite5mTokens = Math.max(
      count(split.ephemeral_5m_input_tokens),
      cacheWriteTotal - usage.cacheWrite1hTokens - unknownWrites,
    );
  }

  const serverTools = isObject(raw.server_tool_use) ? raw.server_tool_use : {};
  usage.webSearchRequests = count(serverTools.web_search_requests);
  for (const [key, value] of Object.entries(serverTools))
    if (key !== "web_search_requests" && typeof value === "number") {
      unrecognised.push(`${prefix}server_tool_use.${key}`);
      usage.otherRequests += count(value);
    }
  return usage;
}

// Converts an API `usage` object.
export function billingFromApi(raw: Json): Billing {
  const unrecognised: string[] = [];
  const usage = usageFields(raw, unrecognised, "");
  const iterations = (Array.isArray(raw.iterations) ? raw.iterations : [])
    .filter(isObject)
    .map((iteration, i) => ({
      model: typeof iteration.model === "string" ? iteration.model : undefined,
      usage: usageFields(iteration, unrecognised, `iterations[${i}].`),
    }));
  return {
    usage,
    speed: typeof raw.speed === "string" ? raw.speed : undefined,
    inferenceGeo: typeof raw.inference_geo === "string" ? raw.inference_geo : undefined,
    iterations,
    unrecognised,
  };
}

// The JSON object that starts at `start`, or undefined. Strings and escapes are
// respected, so braces inside text do not count.
function objectAt(text: string, start: number): string | undefined {
  if (text[start] !== "{") return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

// The top-level `usage` of a Messages response from its last bytes. A `"usage":`
// key cannot occur inside a JSON string (its quotes would be escaped), so the
// candidates are real keys; the last one that holds token counts wins.
export function usageFromTail(text: string): Json | undefined {
  const key = '"usage":';
  for (
    let at = text.lastIndexOf(key);
    at !== -1;
    at = at === 0 ? -1 : text.lastIndexOf(key, at - 1)
  ) {
    let start = at + key.length;
    while (/\s/.test(text[start] ?? "")) start++;
    const candidate = objectAt(text, start);
    if (!candidate) continue;
    try {
      const usage: unknown = JSON.parse(candidate);
      if (isObject(usage) && ("input_tokens" in usage || "output_tokens" in usage)) return usage;
    } catch {
      // Try the previous candidate.
    }
  }
  return undefined;
}

export class UsageTracker {
  readonly streaming: boolean;
  private readonly json: boolean;
  private usage: Json = {};
  private seen = false;
  // SSE state
  private readonly decoder = new TextDecoder();
  private pending = "";
  private discardingLine = false;
  private eventName = "";
  private data: string[] = [];
  private dataBytes = 0;
  private skipEvent = false;
  // JSON state: the last JSON_TAIL_BYTES or a little more.
  private tail: Uint8Array[] = [];
  private tailBytes = 0;
  private totalBytes = 0;

  constructor(contentType: string | null) {
    const type = (contentType ?? "").toLowerCase();
    this.streaming = type.startsWith("text/event-stream");
    this.json = type.startsWith("application/json");
  }

  push(chunk: Uint8Array): void {
    try {
      if (this.streaming) this.feed(this.decoder.decode(chunk, { stream: true }));
      else if (this.json) {
        this.tail.push(chunk);
        this.tailBytes += chunk.byteLength;
        this.totalBytes += chunk.byteLength;
        while (this.tail.length > 1 && this.tailBytes - this.tail[0]!.byteLength >= JSON_TAIL_BYTES)
          this.tailBytes -= this.tail.shift()!.byteLength;
      }
    } catch {
      // Counting is best effort; the bytes are already on their way.
    }
  }

  // What the response reported about its cost, or undefined when it carried
  // no usage.
  finish(): Billing | undefined {
    try {
      if (this.streaming) {
        this.feed(this.decoder.decode());
        if (this.pending && !this.discardingLine) this.line(this.pending);
        this.pending = "";
        this.dispatch();
      } else if (this.json && this.tail.length > 0) {
        const bytes = new Uint8Array(this.tailBytes);
        let offset = 0;
        for (const c of this.tail) {
          bytes.set(c, offset);
          offset += c.byteLength;
        }
        this.tail = [];
        const text = new TextDecoder().decode(bytes);
        let usage: Json | undefined;
        if (this.tailBytes === this.totalBytes)
          try {
            const body: unknown = JSON.parse(text);
            if (isObject(body) && isObject(body.usage)) usage = body.usage;
          } catch {
            // Fall back to the scan.
          }
        usage ??= usageFromTail(text);
        if (usage) this.merge(usage);
      }
    } catch {
      // Fall through with whatever was seen.
    }
    return this.seen ? billingFromApi(this.usage) : undefined;
  }

  private feed(text: string): void {
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      if (newline === -1) {
        if (!this.discardingLine) {
          this.pending += text.slice(start);
          if (this.pending.length > MAX_EVENT_BYTES) {
            this.pending = "";
            this.discardingLine = true;
            this.skipEvent = true;
          }
        }
        return;
      }
      if (this.discardingLine) this.discardingLine = false;
      else {
        const line = this.pending + text.slice(start, newline);
        this.line(line.endsWith("\r") ? line.slice(0, -1) : line);
      }
      this.pending = "";
      start = newline + 1;
    }
  }

  private line(line: string): void {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.eventName = value;
    else if (field === "data" && !this.skipEvent) {
      if (this.eventName && !USAGE_EVENTS.has(this.eventName)) return;
      this.dataBytes += value.length;
      if (this.dataBytes > MAX_EVENT_BYTES) {
        this.skipEvent = true;
        this.data = [];
      } else this.data.push(value);
    }
  }

  private dispatch(): void {
    const data = this.data.join("\n");
    const skip = this.skipEvent;
    this.eventName = "";
    this.data = [];
    this.dataBytes = 0;
    this.skipEvent = false;
    if (skip || !data) return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (!isObject(event)) return;
    if (event.type === "message_start" && isObject(event.message) && isObject(event.message.usage))
      this.merge(event.message.usage);
    else if (event.type === "message_delta" && isObject(event.usage)) this.merge(event.usage);
  }

  // message_delta usage values are cumulative totals, so a later value
  // replaces an earlier one; a field the event leaves out (or sends as null)
  // keeps its earlier value.
  private merge(usage: Json): void {
    this.seen = true;
    for (const [key, value] of Object.entries(usage))
      if (value !== null && value !== undefined) this.usage[key] = value;
  }
}
