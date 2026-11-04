import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import vectors from "../fixtures/ebay-sdk-test.json";
import { CANARY, CLIENT_ID, CLIENT_SECRET, ENDPOINT, TOKEN, headerFor, keypair, notification, pemOf, tempDir, writeFiles } from "./testkit.ts";

// End-to-end log rule (design 3.2): run the real service as a subprocess, send fixture
// notifications that carry recognizable identifiers through every success and error path, and fail
// if any identifier, header value, challenge code, token or credential shows up in stdout, stderr,
// a response, or the database files.

const KID_OK = "aaaaaaaa-0000-4000-8000-000000000001";
const KID_404 = "aaaaaaaa-0000-4000-8000-000000000404";
const KID_500 = "aaaaaaaa-0000-4000-8000-000000000500";
const CHALLENGE_CANARY = "CHALLENGEcanary9z8y7x";
const SDK = vectors.VALID;

function mockEbay(mintFails: boolean) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/identity/v1/oauth2/token")
        return mintFails
          ? new Response("secret-detail " + CANARY.username, { status: 401 })
          : Response.json({ access_token: "ACCESSTOKENcanary55", expires_in: 7200, token_type: "Application Access Token" });
      if (path.endsWith(KID_404)) return new Response("{}", { status: 404 });
      if (path.endsWith(KID_500)) return new Response("boom " + CANARY.userId, { status: 500 });
      if (path.endsWith(SDK.public_key)) return Response.json(SDK.response);
      return Response.json({ key: pemOf(keypair.publicKey), algorithm: "ECDSA", digest: "SHA1" });
    },
  });
}

async function freePorts(): Promise<[number, number]> {
  const a = Bun.serve({ port: 0, fetch: () => new Response() });
  const b = Bun.serve({ port: 0, fetch: () => new Response() });
  const ports: [number, number] = [a.port!, b.port!];
  await a.stop(true);
  await b.stop(true);
  return ports;
}

async function run(mintFails: boolean, drive: (base: string, internal: string, seen: string[]) => Promise<void>) {
  const dir = tempDir();
  const files = writeFiles(dir);
  const ebay = mockEbay(mintFails);
  const [port, internalPort] = await freePorts();
  const child = Bun.spawn(["bun", join(import.meta.dir, "index.ts")], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      ENDPOINT_URL: ENDPOINT.replace("https://ebay-notify.example.test", "https://ebay-notify.example.test"),
      VERIFICATION_TOKEN_FILE: files.token,
      EBAY_CREDENTIALS_FILE: files.creds,
      EBAY_API_BASE: `http://127.0.0.1:${ebay.port}`,
      ALLOW_LOCAL_HTTP: "1",
      DATA_DIR: dir,
      RECEIVER_INIT: "allow",
      PORT: String(port),
      INTERNAL_PORT: String(internalPort),
      HOST: "127.0.0.1",
    },
  });
  const seen: string[] = []; // every response body and header the service produced
  const base = `http://127.0.0.1:${port}`;
  const internal = `http://127.0.0.1:${internalPort}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(internal + "/healthz")).ok) break;
    } catch {}
    await Bun.sleep(50);
  }
  try {
    await drive(base, internal, seen);
  } finally {
    child.kill();
    await child.exited;
    await ebay.stop(true);
  }
  const out = (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
  const dbBytes = readdirSync(dir)
    .filter((f) => f.startsWith("receiver.db"))
    .map((f) => readFileSync(join(dir, f)).toString("latin1"))
    .join("\n");
  return { out, seen: seen.join("\n"), dbBytes };
}

async function send(seen: string[], url: string, init: RequestInit = {}): Promise<number> {
  const response = await fetch(url, init);
  const text = await response.text();
  seen.push(`${response.status}\n${[...response.headers].map(([k, v]) => k + ": " + v).join("\n")}\n${text}`);
  return response.status;
}

function raw(port: number, data: string, seen: string[]): Promise<void> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(data));
    let got = "";
    socket.on("data", (d) => (got += d.toString("latin1")));
    socket.on("error", () => {});
    socket.on("close", () => (seen.push(got), resolve()));
    setTimeout(() => socket.destroy(), 1500);
  });
}

const FORBIDDEN = [
  ...Object.values(CANARY),
  "canary",
  CHALLENGE_CANARY,
  TOKEN,
  CLIENT_ID,
  CLIENT_SECRET,
  "ACCESSTOKENcanary55",
  "secret-detail",
  "boom",
  SDK.message.notification.data.username,
  SDK.message.notification.data.userId,
  SDK.message.notification.data.eiasToken,
];

describe("log and response leak test", () => {
  test("no identifier, header value, challenge code, token or credential leaves the service on any path", async () => {
    const post = (b: string, headers: Record<string, string>) => ({ method: "POST", body: b, headers });
    const headersSeen: string[] = [];
    const result = await run(false, async (base, internal, seen) => {
      const url = base + "/ebay/notify";
      const good = notification("leak-ok-1");
      const goodHeader = headerFor(good, KID_OK);
      headersSeen.push(goodHeader);
      const statuses: number[] = [];
      // success, duplicate
      statuses.push(await send(seen, url, post(good, { "content-type": "application/json", "x-ebay-signature": goodHeader })));
      statuses.push(await send(seen, url, post(good, { "content-type": "application/json", "x-ebay-signature": goodHeader })));
      // the published SDK vector (carries its own canary identifiers) through the real server
      statuses.push(await send(seen, url, post(JSON.stringify(SDK.message), { "content-type": "application/json", "x-ebay-signature": SDK.signature })));
      // signature mismatch, tampered body, wrong key signature
      statuses.push(await send(seen, url, post(good.replace("leak-ok-1", "leak-ok-2"), { "content-type": "application/json", "x-ebay-signature": goodHeader })));
      statuses.push(await send(seen, url, post(JSON.stringify(vectors.SIGNATURE_MISMATCH.message), { "content-type": "application/json", "x-ebay-signature": vectors.SIGNATURE_MISMATCH.signature })));
      // unknown key id (eBay 404) and key outage (eBay 500)
      const b2 = notification("leak-404");
      statuses.push(await send(seen, url, post(b2, { "content-type": "application/json", "x-ebay-signature": headerFor(b2, KID_404) })));
      const b3 = notification("leak-500");
      statuses.push(await send(seen, url, post(b3, { "content-type": "application/json", "x-ebay-signature": headerFor(b3, KID_500) })));
      // signed bad JSON whose text holds a canary: JSON.parse errors quote input
      const badJson = `{"metadata":{"topic":"x"}, "data": ${CANARY.username} <<<`;
      statuses.push(await send(seen, url, post(badJson, { "content-type": "application/json", "x-ebay-signature": headerFor(badJson, KID_OK) })));
      // signed wrong topic and bad schema
      const wrongTopic = notification("leak-topic", "OTHER");
      statuses.push(await send(seen, url, post(wrongTopic, { "content-type": "application/json", "x-ebay-signature": headerFor(wrongTopic, KID_OK) })));
      // wrong content type, missing signature, malformed signature header carrying a canary
      statuses.push(await send(seen, url, post(good, { "content-type": "text/plain", "x-ebay-signature": goodHeader })));
      statuses.push(await send(seen, url, post(good, { "content-type": "application/json" })));
      const evilHeader = Buffer.from(JSON.stringify({ kid: CANARY.userId, signature: CANARY.eiasToken })).toString("base64");
      headersSeen.push(evilHeader);
      statuses.push(await send(seen, url, post(good, { "content-type": "application/json", "x-ebay-signature": evilHeader })));
      // oversize body with canary
      statuses.push(await send(seen, url, post(CANARY.username.repeat(2000), { "content-type": "application/json", "x-ebay-signature": goodHeader })));
      // challenge (good and bad) with a recognizable code
      statuses.push(await send(seen, url + "?challenge_code=" + CHALLENGE_CANARY));
      statuses.push(await send(seen, url + "?challenge_code=" + CHALLENGE_CANARY + "%00bad"));
      // unknown paths and methods with canaries in path, query and a forged Host
      statuses.push(await send(seen, base + "/" + CANARY.username + "?u=" + CANARY.userId));
      statuses.push(await send(seen, url, { method: "PUT", body: CANARY.eiasToken }));
      statuses.push(await send(seen, base + "/state"));
      statuses.push(await send(seen, internal + "/state"));
      statuses.push(await send(seen, internal + "/healthz"));
      statuses.push(await send(seen, base + "/metrics"));
      // scrape after every identifier path above: counters have moved, and nothing may leak
      const scrape = await fetch(internal + "/metrics");
      const metricsText = await scrape.text();
      seen.push(metricsText);
      expect(scrape.status).toBe(200);
      expect(metricsText).toMatch(/ebay_receiver_notifications_total\{outcome="stored"\} [1-9]/);
      expect(metricsText).toMatch(/ebay_receiver_notifications_total\{outcome="bad_signature"\} [1-9]/);
      expect(metricsText).toMatch(/ebay_receiver_challenges_total\{outcome="ok"\} [1-9]/);
      // malformed HTTP and an over-long header with canaries
      await raw(Number(new URL(base).port), `GET /${CANARY.username} HTTP/1.1\r\nHost: ${CANARY.userId}\r\nX: ${"a".repeat(20000)}${CANARY.eiasToken}\r\n\r\n`, seen);
      await raw(Number(new URL(base).port), `NOT HTTP ${CANARY.username}\r\n\r\n`, seen);
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses).toContain(412);
      expect(statuses).toContain(503);
      expect(statuses).toContain(413);
      expect(statuses).toContain(400);
      expect(statuses).toContain(404);
    });
    expect(result.out).toContain('"event":"notification-stored"');
    for (const needle of [...FORBIDDEN, ...headersSeen]) {
      expect(result.out).not.toContain(needle);
      expect(result.seen).not.toContain(needle);
      expect(result.dbBytes).not.toContain(needle);
    }
    // every log line is one JSON object with only the allowed keys
    for (const line of result.out.trim().split("\n")) {
      const o = JSON.parse(line) as Record<string, unknown>;
      for (const k of Object.keys(o)) expect(["t", "event", "status", "bytes", "ms", "reason", "id"]).toContain(k);
    }
  }, 30000);

  test("mint failure path (eBay 401 with a body) leaks nothing", async () => {
    const result = await run(true, async (base, _i, seen) => {
      const b = notification("leak-mint");
      expect(await send(seen, base + "/ebay/notify", { method: "POST", body: b, headers: { "content-type": "application/json", "x-ebay-signature": headerFor(b, KID_OK) } })).toBe(503);
    });
    for (const needle of FORBIDDEN) {
      expect(result.out).not.toContain(needle);
      expect(result.seen).not.toContain(needle);
    }
    expect(result.out).toContain('"reason":"mint-failed"');
  }, 20000);
});
