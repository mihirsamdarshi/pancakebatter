import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProbeOptions, technicalEbayEvidence } from "../scripts/probe-ebay-support.ts";

const credentials = JSON.stringify({ clientId: "SYNTHETIC_CLIENT_ID", clientSecret: "SYNTHETIC_CLIENT_SECRET" });
const token = { access_token: "SYNTHETIC_ACCESS_TOKEN", expires_in: 7200, token_type: "Application Access Token" };
const item = {
  itemId: "v1|123456789012|0", legacyItemId: "123456789012",
  title: "SYNTHETIC_LISTING_TITLE", seller: { username: "SYNTHETIC_SELLER_NAME" },
  price: { value: "654.32", currency: "USD" },
};
const argumentsFor = (mode = "search") => [
  "--mode", mode, "--id", "123456789012", "--zip", "10001", "--technical-only",
];
interface Plan {
  oauthStatus?: number;
  oauth?: unknown;
  browseStatus?: number;
  browse?: unknown;
}
async function run(args: string[], plan: Plan = {}, input = credentials) {
  const dir = await mkdtemp(join(tmpdir(), "ebay-technical-probe-"));
  try {
    const guard = join(dir, "guard.ts");
    await writeFile(guard, `
      const plan = ${JSON.stringify({ oauthStatus: 200, oauth: token, browseStatus: 200, browse: { itemSummaries: [item] }, ...plan })};
      let requests = 0;
      process.on("exit", () => console.error(JSON.stringify({ testOnlyRequests: requests })));
      globalThis.fetch = async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        requests++;
        if (url.origin !== "https://api.ebay.com") throw new Error("UNEXPECTED_NETWORK");
        const oauth = url.pathname === "/identity/v1/oauth2/token";
        if ((requests === 1 && !oauth) || (requests === 2 && oauth) || requests > 2)
          throw new Error("UNEXPECTED_RETRY");
        const body = oauth ? plan.oauth : plan.browse;
        const status = oauth ? plan.oauthStatus : plan.browseStatus;
        return typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status });
      };
    `);
    const child = Bun.spawn([process.execPath, "--preload", guard, join(import.meta.dir, "../scripts/probe-ebay.ts"), ...args], {
      stdin: new Response(input), stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 3000);
    try {
      const [out, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      const lines = stderr.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const requests = lines.find((line) => "testOnlyRequests" in line)?.testOnlyRequests;
      const errors = lines.filter((line) => !("testOnlyRequests" in line));
      for (const secret of ["SYNTHETIC_CLIENT_ID", "SYNTHETIC_CLIENT_SECRET", "SYNTHETIC_ACCESS_TOKEN", "SYNTHETIC_LISTING_TITLE", "SYNTHETIC_SELLER_NAME", "123456789012", "654.32", "UNEXPECTED_NETWORK", "UNEXPECTED_RETRY"])
        expect(out + stderr).not.toContain(secret);
      return { result: out ? JSON.parse(out) : null, errors, code, requests };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("technical dry run performs no credential parsing or network access", async () => {
  const result = await run(argumentsFor(), {}, "SYNTHETIC_INVALID_STDIN");
  expect(result.code).toBe(0);
  expect(result.requests).toBe(0);
  expect(result.errors).toEqual([]);
  expect(result.result).toEqual({ source: "ebay", mode: "search", production: true, dryRun: true, technicalOnly: true });
});

test("strict flags reject typos, duplicates and missing values before stdin/network", async () => {
  for (const args of [
    [...argumentsFor(), "--technical-only"], [...argumentsFor(), "--mode", "item"],
    [...argumentsFor(), "--probe", "--probe"], [...argumentsFor(), "--id"],
    [...argumentsFor(), "--technicalonly"], ["--mode", "--id", "123456789012", "--zip", "10001"],
  ]) expect(parseProbeOptions(args)).toBeNull();
  const result = await run([...argumentsFor(), "--technicalonly", "--probe"], {}, "SYNTHETIC_INVALID_STDIN");
  expect(result.code).toBe(2);
  expect(result.requests).toBe(0);
  expect(result.errors).toEqual([{ source: "ebay", error: "invalid-arguments" }]);
});

test("technical probe distinguishes credential, OAuth and Browse failures without values or retries", async () => {
  for (const [plan, input, stage, requests, error] of [
    [{}, "not-json", "credentials", 0, "credentials-or-data-unavailable"],
    [{ oauthStatus: 401, oauth: { error_description: "SYNTHETIC_ACCESS_TOKEN" } }, credentials, "oauth", 1, "access-denied"],
    [{ browseStatus: 403, browse: { message: "SYNTHETIC_LISTING_TITLE" } }, credentials, "browse", 2, "access-denied"],
  ] as const) {
    const result = await run([...argumentsFor(), "--probe"], plan, input);
    expect(result.code).toBe(1);
    expect(result.requests).toBe(requests);
    expect(result.errors).toEqual([{ source: "ebay", technicalOnly: true, stage, error }]);
  }
});

test("technical search/detail success emits only fixed technical predicates", async () => {
  for (const mode of ["search", "item"]) {
    const result = await run([...argumentsFor(mode), "--probe"], { browse: mode === "search" ? { itemSummaries: [item] } : item });
    expect(result.code).toBe(0);
    expect(result.requests).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.result).toEqual({ source: "ebay", mode, production: true, observedAt: expect.any(String),
      technicalOnly: true, oauthValidated: true, browseResponseAccepted: true,
      responseContainerRecognized: true, itemIdentitySchemaObserved: true, qualificationEstablished: false });
  }
});

test("zero search results do not claim item schema evidence", async () => {
  const result = await run([...argumentsFor(), "--probe"], { browse: { total: 0 } });
  expect(result.code).toBe(0);
  expect(result.requests).toBe(2);
  expect(result.result.itemIdentitySchemaObserved).toBe(false);
  expect(result.result.qualificationEstablished).toBe(false);
});

test("technical schema validation rejects warnings, malformed identities and oversized item sets", () => {
  for (const value of [
    { warnings: [{ message: "SYNTHETIC_LISTING_TITLE" }], itemSummaries: [item] },
    { errors: [{ message: "SYNTHETIC_LISTING_TITLE" }], itemSummaries: [item] },
    { itemSummaries: [{ itemId: "SYNTHETIC_LISTING_TITLE" }] },
    { itemSummaries: Array(11).fill(item) }, { total: 0, itemSummaries: [item] },
    { warnings: "SYNTHETIC_LISTING_TITLE", itemSummaries: [] },
  ]) expect(() => technicalEbayEvidence("search", value)).toThrow("invalid-data");
});

test("unsupported or oversized upstream/input data remains a generic failure", async () => {
  for (const [plan, input, stage, requests] of [
    [{ browse: { warnings: [{ message: "SYNTHETIC_LISTING_TITLE" }], itemSummaries: [item] } }, credentials, "browse", 2],
    [{ browse: "SYNTHETIC_LISTING_TITLE" }, credentials, "browse", 2],
    [{ browse: "x".repeat(1024 * 1024 + 1) }, credentials, "browse", 2],
    [{}, "x".repeat(16385), "credentials", 0],
  ] as const) {
    const result = await run([...argumentsFor(), "--probe"], plan, input);
    expect(result.code).toBe(1);
    expect(result.requests).toBe(requests);
    expect(result.errors).toEqual([{ source: "ebay", technicalOnly: true, stage, error: "invalid-data" }]);
  }
});
