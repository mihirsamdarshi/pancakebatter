import type { Usage } from "./prices.ts";

// Reads token usage from an upstream response while the bytes pass through
// unchanged. Nothing here may throw into the pass-through: a body the tracker
// cannot read is still delivered, it is only not counted.

// A non-streaming Messages response is small; past this it is not parsed.
const MAX_JSON_BYTES = 16 * 1024 * 1024;
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

// Converts an API `usage` object. Without a `cache_creation` split, every
// cache write is taken to be a 5-minute write.
export function usageFromApi(raw: Json): Usage {
  const cacheWriteTotal = count(raw.cache_creation_input_tokens);
  const split = isObject(raw.cache_creation) ? raw.cache_creation : undefined;
  let cacheWrite5mTokens = cacheWriteTotal;
  let cacheWrite1hTokens = 0;
  if (split) {
    cacheWrite1hTokens = count(split.ephemeral_1h_input_tokens);
    cacheWrite5mTokens = Math.max(
      count(split.ephemeral_5m_input_tokens),
      cacheWriteTotal - cacheWrite1hTokens,
    );
  }
  const serverTools = isObject(raw.server_tool_use) ? raw.server_tool_use : {};
  return {
    inputTokens: count(raw.input_tokens),
    outputTokens: count(raw.output_tokens),
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    cacheReadTokens: count(raw.cache_read_input_tokens),
    webSearchRequests: count(serverTools.web_search_requests),
  };
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
  // JSON state
  private chunks: Uint8Array[] = [];
  private size = 0;

  constructor(contentType: string | null) {
    const type = (contentType ?? "").toLowerCase();
    this.streaming = type.startsWith("text/event-stream");
    this.json = type.startsWith("application/json");
  }

  push(chunk: Uint8Array): void {
    try {
      if (this.streaming) this.feed(this.decoder.decode(chunk, { stream: true }));
      else if (this.json && this.size <= MAX_JSON_BYTES) {
        this.size += chunk.byteLength;
        if (this.size <= MAX_JSON_BYTES) this.chunks.push(chunk);
        else this.chunks = [];
      }
    } catch {
      // Counting is best effort; the bytes are already on their way.
    }
  }

  // Usage seen so far, or undefined when the response carried none.
  finish(): Usage | undefined {
    try {
      if (this.streaming) {
        this.feed(this.decoder.decode());
        if (this.pending && !this.discardingLine) this.line(this.pending);
        this.pending = "";
        this.dispatch();
      } else if (this.json && this.chunks.length > 0) {
        const bytes = new Uint8Array(this.size);
        let offset = 0;
        for (const c of this.chunks) {
          bytes.set(c, offset);
          offset += c.byteLength;
        }
        this.chunks = [];
        const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (isObject(body) && isObject(body.usage)) this.merge(body.usage);
      }
    } catch {
      // Fall through with whatever was seen.
    }
    return this.seen ? usageFromApi(this.usage) : undefined;
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
