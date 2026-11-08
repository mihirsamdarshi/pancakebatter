import { expect, test } from "bun:test";
import {
  EbayClient,
  parseEbayCredentials,
  readEbayCredentials,
} from "./ebay.ts";
const credentials = {
  clientId: "synthetic-client",
  clientSecret: "synthetic-secret",
};
test("eBay token is cached, concurrent mints coalesce, headers stay on fixed production origin", async () => {
  let mints = 0,
    reads = 0;
  const client = new EbayClient(credentials, async (request) => {
    expect(request.url.startsWith("https://api.ebay.com/")).toBe(true);
    expect(request.redirect).toBe("error");
    if (request.method === "POST") {
      mints++;
      expect(request.headers.get("authorization")).toStartWith("Basic ");
      expect(await request.text()).toContain("grant_type=client_credentials");
      return Response.json({
        access_token: "synthetic-access-token",
        expires_in: 7200,
        token_type: "Application Access Token",
      });
    }
    reads++;
    expect(request.headers.get("authorization")).toBe(
      "Bearer synthetic-access-token",
    );
    expect(request.headers.get("X-EBAY-C-ENDUSERCTX")).toBe(
      "contextualLocation=country%3DUS%2Czip%3D10001",
    );
    return Response.json({ itemId: "v1|123456789012|0" });
  });
  await Promise.all([
    client.getItem("123456789012", "10001"),
    client.getItem("123456789013", "10001"),
  ]);
  await client.getItem("123456789014", "10001");
  expect(mints).toBe(1);
  expect(reads).toBe(3);
});
test("eBay never retries a failed token mint or leaks response text", async () => {
  let calls = 0;
  const client = new EbayClient(credentials, async () => {
    calls++;
    return new Response("sensitive-upstream-error", { status: 403 });
  });
  await expect(client.getItem("123456789012", "10001")).rejects.toThrow(
    "access-denied",
  );
  await expect(client.getItem("123456789012", "10001")).rejects.toThrow(
    "throttled",
  );
  expect(calls).toBe(1);
});
test("eBay refuses caller URL injection and sandbox-shaped IDs before any request", () => {
  const client = new EbayClient(credentials, async () => {
    throw Error("unexpected request");
  });
  expect(() => client.getItem("https://evil.example", "10001")).toThrow(
    "invalid-data",
  );
  expect(() => client.searchByGtin("1234", "10001")).toThrow("invalid-data");
});

test("eBay refreshes expired tokens without refreshing on every read", async () => {
  let now = 0,
    mints = 0;
  const client = new EbayClient(
    credentials,
    async (r) =>
      r.method === "POST"
        ? Response.json({
            access_token: "synthetic-" + ++mints,
            expires_in: 7200,
            token_type: "Application Access Token",
          })
        : Response.json({}),
    () => now,
  );
  await client.getItem("123456789012", "10001");
  now = 7139000;
  await client.getItem("123456789012", "10001");
  expect(mints).toBe(1);
  now = 7140000;
  await client.getItem("123456789012", "10001");
  expect(mints).toBe(2);
});
test("eBay rejects malformed and oversized token responses", async () => {
  for (const value of [
    {
      access_token: "x",
      expires_in: 0,
      token_type: "Application Access Token",
    },
    {
      access_token: "x\nsecret",
      expires_in: 7200,
      token_type: "Application Access Token",
    },
    { access_token: "x", expires_in: 7200, token_type: "Bearer" },
  ]) {
    const client = new EbayClient(credentials, async () =>
      Response.json(value),
    );
    await expect(client.getItem("123456789012", "10001")).rejects.toThrow(
      "invalid-data",
    );
  }
  const client = new EbayClient(
    credentials,
    async () => new Response("x".repeat(1024 * 1024 + 1)),
  );
  await expect(client.getItem("123456789012", "10001")).rejects.toThrow(
    "invalid-data",
  );
});
test("eBay reports API denial and throttles without automatic retries", async () => {
  for (const status of [401, 403, 429]) {
    let calls = 0;
    const client = new EbayClient(credentials, async (r) => {
      calls++;
      return r.method === "POST"
        ? Response.json({
            access_token: "synthetic-token",
            expires_in: 7200,
            token_type: "Application Access Token",
          })
        : new Response("not logged", {
            status,
            headers: { "retry-after": "600" },
          });
    });
    await expect(client.getItem("123456789012", "10001")).rejects.toThrow(
      status === 429 ? "throttled" : "access-denied",
    );
    expect(calls).toBe(2);
  }
});
test("eBay converts transport errors and redirects to redacted failures", async () => {
  const client = new EbayClient(credentials, async () => {
    throw Error("must not expose credential or request URL");
  });
  await expect(client.getItem("123456789012", "10001")).rejects.toThrow(
    "network",
  );
  const redirect = new EbayClient(
    credentials,
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://example.invalid" },
      }),
  );
  await expect(redirect.getItem("123456789012", "10001")).rejects.toThrow(
    "network",
  );
});
test("OAuth Retry-After is retained beyond the normal mint floor", async () => {
  let now = 0,
    calls = 0;
  const client = new EbayClient(
    credentials,
    async () => {
      calls++;
      return new Response(null, {
        status: 429,
        headers: { "retry-after": "600" },
      });
    },
    () => now,
  );
  await expect(client.getItem("123456789012", "10001")).rejects.toThrow(
    "throttled",
  );
  now = 60001;
  await expect(client.getItem("123456789012", "10001")).rejects.toThrow(
    "throttled",
  );
  expect(calls).toBe(1);
  now = 600000;
  await expect(client.getItem("123456789012", "10001")).rejects.toThrow(
    "throttled",
  );
  expect(calls).toBe(2);
});

test("credential parsing is strict and errors are redacted", () => {
  expect(parseEbayCredentials(JSON.stringify(credentials))).toEqual(
    credentials,
  );
  for (const body of [
    "synthetic-secret",
    "x".repeat(16385),
    JSON.stringify({ ...credentials, extra: "secret" }),
    JSON.stringify({ ...credentials, clientId: "bad:secret" }),
    "{}",
  ])
    expect(() => parseEbayCredentials(body)).toThrow(
      "Invalid or missing eBay credential file",
    );
  expect(() => readEbayCredentials("/nonexistent/synthetic-secret")).toThrow(
    "Invalid or missing eBay credential file",
  );
});
test("only explicit OAuth invalid-token errors invalidate cached tokens", async () => {
  for (const [status, body, expectedMints] of [
    [403, { errors: [{ errorId: 1100, domain: "OAuth" }] }, 1],
    [401, {}, 1],
    [401, { errors: [{ errorId: 1001, domain: "OAuth" }] }, 2],
  ] as const) {
    let mints = 0,
      reads = 0,
      now = 0;
    const client = new EbayClient(
      credentials,
      async (r) =>
        r.method === "POST"
          ? Response.json({
              access_token: "synthetic-" + ++mints,
              expires_in: 7200,
              token_type: "Application Access Token",
            })
          : ++reads === 1
            ? Response.json(body, { status })
            : Response.json({}),
      () => now,
    );
    await expect(client.getItem("123456789012", "10001")).rejects.toThrow(
      "access-denied",
    );
    now = 60001;
    await client.getItem("123456789012", "10001");
    expect(mints).toBe(expectedMints);
    expect(reads).toBe(2);
  }
});
test("REST variation identity survives a fixed-origin detail request", async () => {
  const client = new EbayClient(credentials, async (r) => {
    if (r.method === "POST")
      return Response.json({
        access_token: "synthetic",
        expires_in: 7200,
        token_type: "Application Access Token",
      });
    expect(r.url).toBe(
      "https://api.ebay.com/buy/browse/v1/item/v1%7C123456789012%7C123456789?quantity_for_shipping_estimate=1&fieldgroups=PRODUCT",
    );
    return Response.json({});
  });
  await client.getRestItem("v1|123456789012|123456789", "10001");
  expect(() => client.getRestItem("v1|123456789012|0/evil", "10001")).toThrow(
    "invalid-data",
  );
});
