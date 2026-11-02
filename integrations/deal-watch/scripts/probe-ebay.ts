/** One production read only, with credentials via bounded stdin; no app/Discord writes. */
import { ebayEvidence } from "../src/ebay-evidence.ts";
import { EbayClient, parseEbayCredentials } from "../src/ebay.ts";
import { boundedText, UpstreamError } from "../src/http.ts";
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const mode = option("--mode"),
  id = option("--id"),
  zip = option("--zip");
if (
  !["search", "item"].includes(mode ?? "") ||
  !id ||
  !zip ||
  !/^\d{5}$/.test(zip) ||
  !(
    mode === "search" ? /^\d{8,14}$/ : /^(?:\d{9,20}|v1\|\d{9,20}\|\d{1,20})$/
  ).test(id)
) {
  console.error(
    "Usage: <credential-json-stdin> | bun scripts/probe-ebay.ts --mode search|item --id GTIN|legacy-item-id --zip ZIP --probe",
  );
  process.exit(2);
}
if (!args.includes("--probe")) {
  console.log(
    JSON.stringify({ source: "ebay", mode, production: true, dryRun: true }),
  );
  process.exit(0);
}

try {
  const credentials = parseEbayCredentials(
    await boundedText(new Response(Bun.stdin.stream()), 16384),
  );
  const client = new EbayClient(credentials);
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
      ...ebayEvidence(mode === "search" ? "search" : "item", response),
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      source: "ebay",
      error:
        error instanceof UpstreamError
          ? error.code
          : "credentials-or-data-unavailable",
    }),
  );
  process.exit(1);
}
