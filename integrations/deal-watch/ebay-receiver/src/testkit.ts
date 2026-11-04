import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { KeyDirectory, type Fetcher } from "./keys.ts";
import { createLogger } from "./log.ts";
import { Receiver, type Incoming } from "./receiver.ts";
import { openStore } from "./store.ts";

// Fake values only. Nothing here is real and the zone is never used.
export const ENDPOINT = "https://ebay-notify.example.test/ebay/notify";
export const TOKEN = "tok_0123456789abcdef0123456789ABCDEF-xyz";
export const CLIENT_ID = "fake-client-id";
export const CLIENT_SECRET = "fake-client-secret";
export const KID = "11111111-2222-3333-4444-555555555555";
/** Recognizable identifiers, fed through every path by the leak tests. */
export const CANARY = { username: "canary_user_Zq81", userId: "canaryUserIdQ7x2", eiasToken: "canaryEiasTokenK3m9==" };

export const keypair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

export function pemOf(key: KeyObject): string {
  return key.export({ type: "spki", format: "pem" }).toString().replace(/\n/g, "");
}

export function notification(id: string, topic = "MARKETPLACE_ACCOUNT_DELETION"): string {
  return JSON.stringify({
    metadata: { topic, schemaVersion: "1.0", deprecated: false },
    notification: {
      notificationId: id,
      eventDate: "2026-11-03T20:43:59.462Z",
      publishDate: "2026-11-03T20:43:59.679Z",
      publishAttemptCount: 1,
      data: { ...CANARY },
    },
  });
}

export function headerFor(body: string, kid = KID, key: KeyObject = keypair.privateKey): string {
  const signature = sign("sha1", Buffer.from(body), key).toString("base64");
  return Buffer.from(JSON.stringify({ alg: "ecdsa", kid, signature, digest: "SHA1" })).toString("base64");
}

export interface MockEbay {
  fetcher: Fetcher;
  calls: string[];
  mode: { mint: "ok" | "fail"; keys: "ok" | "404" | "500" | "stall" };
}

export function mockEbay(): MockEbay {
  const calls: string[] = [];
  const mode: MockEbay["mode"] = { mint: "ok", keys: "ok" };
  const fetcher: Fetcher = async (request) => {
    const url = new URL(request.url);
    calls.push(url.pathname);
    if (url.pathname === "/identity/v1/oauth2/token") {
      if (mode.mint === "fail") return new Response("{}", { status: 401 });
      return Response.json({ access_token: "fake-access-token", expires_in: 7200, token_type: "Application Access Token" });
    }
    if (url.pathname.startsWith("/commerce/notification/v1/public_key/")) {
      if (mode.keys === "stall") await new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      if (mode.keys === "404") return new Response("{}", { status: 404 });
      if (mode.keys === "500") return new Response("{}", { status: 500 });
      return Response.json({ key: pemOf(keypair.publicKey), algorithm: "ECDSA", digest: "SHA1" });
    }
    return new Response("no", { status: 404 });
  };
  return { fetcher, calls, mode };
}

export function makeConfig(dir: string, over: Partial<Config> = {}): Config {
  return {
    endpoint: ENDPOINT,
    endpointPath: "/ebay/notify",
    verificationToken: TOKEN,
    credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    apiBase: "https://api.ebay.com",
    dataDir: dir,
    init: "allow",
    port: 0,
    internalPort: 0,
    host: "127.0.0.1",
    selfTest: false,
    ...over,
  };
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "receiver-test-"));
}

export function writeFiles(dir: string): { creds: string; token: string } {
  const creds = join(dir, "creds.json");
  const token = join(dir, "token");
  writeFileSync(creds, JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }));
  writeFileSync(token, TOKEN + "\n");
  return { creds, token };
}

export function setup(over: Partial<Config> = {}, clock: { t: number } = { t: 1_800_000_000_000 }) {
  const dir = tempDir();
  const config = makeConfig(dir, over);
  const lines: string[] = [];
  const log = createLogger((l) => lines.push(l), () => clock.t);
  const ebay = mockEbay();
  const keys = new KeyDirectory(config.credentials, config.apiBase, ebay.fetcher, () => clock.t);
  const opened = openStore(dir, config.init);
  const receiver = new Receiver(config, opened.store, opened.store ? null : opened.reason, keys, log, () => clock.t);
  return { dir, config, lines, ebay, keys, opened, receiver, clock };
}

export function request(
  method: string,
  target: string,
  headers: Record<string, string> = {},
  body: string | Buffer = "",
  readResult?: "too-large" | "timeout",
): Incoming {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method,
    target,
    header: (n) => lower[n.toLowerCase()],
    readBody: async (max) => (readResult ? readResult : Buffer.byteLength(body) > max ? "too-large" : Buffer.from(body)),
  };
}

export const post = (body: string, header = headerFor(body), extra: Record<string, string> = {}) =>
  request("POST", "/ebay/notify", { "content-type": "application/json", "x-ebay-signature": header, ...extra }, body);
