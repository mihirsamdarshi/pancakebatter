export type Fetcher = (request: Request) => Promise<Response>;
export class UpstreamError extends Error {
  constructor(
    readonly code: "network" | "throttled" | "access-denied" | "invalid-data" | "unsupported",
    readonly retryAfterMs = 0,
  ) {
    super(code);
  }
}
export async function boundedText(response: Response, maxBytes = 4 * 1024 * 1024): Promise<string> {
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body?.cancel();
    throw new UpstreamError("invalid-data");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new UpstreamError("invalid-data");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new UpstreamError("invalid-data");
  }
}
export function retryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value),
    delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.min(Math.max(delay, 0), 86_400_000) : 0;
}
export const nativeFetch: Fetcher = (request) => fetch(request);
export async function getPublic(url: string, fetcher: Fetcher = nativeFetch): Promise<string> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !["api.direct.playstation.com", "www.costco.com"].includes(parsed.hostname)
  )
    throw new UpstreamError("unsupported");
  try {
    const res = await fetcher(
      new Request(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: "application/json,text/html",
          "user-agent": "DealWatch/0.1 (personal shopping monitor)",
        },
      }),
    );
    if (res.status === 429) {
      await res.body?.cancel();
      throw new UpstreamError("throttled", retryAfter(res.headers.get("retry-after")));
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw new UpstreamError("access-denied");
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new UpstreamError("network");
    }
    return await boundedText(res);
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError("network");
  }
}
