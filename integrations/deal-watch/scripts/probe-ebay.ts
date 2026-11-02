/** One production read only, with credentials via bounded stdin; no app/Discord writes. */
import { ebayEvidence } from "../src/ebay-evidence.ts";
import { EbayClient, parseEbayCredentials } from "../src/ebay.ts";
import { boundedText, nativeFetch, UpstreamError, type Fetcher } from "../src/http.ts";
import { parseProbeOptions, technicalEbayEvidence } from "./probe-ebay-support.ts";
const options = parseProbeOptions(process.argv.slice(2));
if (!options) {
  console.error(JSON.stringify({ source: "ebay", error: "invalid-arguments" }));
  process.exit(2);
}
const { mode, id, zip, technicalOnly } = options;
if (!options.probe) {
  console.log(
    JSON.stringify({ source: "ebay", mode, production: true, dryRun: true, ...(technicalOnly ? { technicalOnly: true } : {}) }),
  );
  process.exit(0);
}

let stage: "credentials" | "oauth" | "browse" = "credentials";
try {
  const credentials = parseEbayCredentials(
    await boundedText(new Response(Bun.stdin.stream()), 16384),
  );
  const observeStage: Fetcher = (request) => {
    const url = new URL(request.url);
    if (url.origin !== "https://api.ebay.com") throw new UpstreamError("unsupported");
    if (url.pathname === "/identity/v1/oauth2/token" && request.method === "POST") stage = "oauth";
    else if (url.pathname.startsWith("/buy/browse/v1/") && request.method === "GET") stage = "browse";
    else throw new UpstreamError("unsupported");
    return nativeFetch(request);
  };
  const client = new EbayClient(credentials, technicalOnly ? observeStage : undefined);
  const response =
    mode === "search"
      ? await client.searchByGtin(id, zip)
      : id.startsWith("v1|")
        ? await client.getRestItem(id, zip)
        : await client.getItem(id, zip);
  console.log(
    JSON.stringify({
      source: "ebay",
      mode,
      production: true,
      observedAt: new Date().toISOString(),
      ...(technicalOnly ? {
        technicalOnly: true,
        oauthValidated: true,
        browseResponseAccepted: true,
        ...technicalEbayEvidence(mode, response),
      } : ebayEvidence(mode, response)),
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      source: "ebay",
      ...(technicalOnly ? { technicalOnly: true, stage } : {}),
      error:
        error instanceof UpstreamError
          ? error.code
          : "credentials-or-data-unavailable",
    }),
  );
  process.exit(1);
}
