# Deal Watch integrations

Outbound collection and fixed-channel Discord delivery for the credential-free
Deal Watch app. This is infrastructure outside the personal app platform.
No retailer login state, generic URL proxy or purchasing is included. Target and Best Buy
use a separate browser service (see below); this worker has no browser itself.

## Implemented and gated

Sony Direct's public website product response is parsed by exact product ID,
USD price and explicit stock fields. It is a website backend, not a promised
stable developer API. Out-of-stock wins over purchasable; order limits are not
inventory. Preorder, gated or incomplete responses cannot qualify. A reviewed
shipping-policy ZIP allowlist can establish policy-supported free standard
shipping above $40; it never establishes ZIP-specific checkout availability.

Costco Product JSON-LD is parsed by exact SKU and one unambiguous offer.
When the binding's `shippingPolicyZips` lists the watch ZIP and the price is over
$40, the offer takes free shipping and zero other mandatory fees. This is an
assumption, the same one the Sony adapter makes: the listing says standard
shipping is included, the owner holds an active Costco membership, and free policy
shipping is taken to mean no other mandatory fees. The California recycling fee is
outside the owner's ceiling by owner decision. Without the ZIP, shipping and fees
stay unknown and the offer cannot qualify.

The bundle's extra controller gets its reference price from Sony Direct. The
worker makes one extra `productList` request after a Sony console check, at most
once per 6 hours, and only while an enabled binding lists a mapped extra. It uses
the first valid mapped code: the Gray Camouflage part number (unverified on Sony
Direct), else the standard white DualSense as a fallback. A failed reference
request changes nothing about the Sony check and logs one outcome-only JSON line;
the next attempt follows after 6 hours on success, otherwise after 30 minutes.
A reference older than 24 hours is ignored, and the offer then reports
`Bundle reference price missing or stale`. Whether the Costco binding is enabled
depends on the owner's private policy.
eBay is disabled pending access/extraction proof; there is no claim that it is
continuously monitored.

### Browser-backed sources: Target and Best Buy

These two retailers do not offer a usable public JSON endpoint, so the worker asks a
separate browser service for one public product page load per check
(`POST ${BROWSER_URL}/observe` with `{retailer, productId, path}`, where `path` is the binding's `pagePath`, checked by the worker and again by the service; 120 s timeout; response
read capped at 13 MiB). The service returns only allowlisted JSON responses with
secret-like keys removed. The worker keeps all scheduling, floors, backoff, parsing
and qualification. `BROWSER_URL` must be an `http(s)` origin with no credentials,
path or query. When it is unset these bindings fail as `unsupported` and make no request.
A service 429 is `throttled`, a human-check page is `access-denied`, a page error is
`network`, and unparseable or oversize data is `invalid-data`.

- Target: product objects whose own `tcin` is the binding's TCIN. Price is
  `price.formatted_current_price` (cross-checked with `current_retail`). Stock is
  `fulfillment.shipping_options.availability_status`: `IN_STOCK`, `OUT_OF_STOCK`, else
  unknown; a `sold_out` flag or zero available quantity contradicting `IN_STOCK` gives unknown.
  Target's data has no first-party seller field. The product is treated as Target's own
  only while it holds no seller, vendor, marketplace or partner value; any such value
  rejects the offer. The binding's TCIN must be Target's own listing: Target Plus partner
  items use separate TCINs and the data carries no seller field to tell them apart.
  Target `pagePath` is `/p/-/A-<TCIN>`; Best Buy's is
  `/product/<slug>/<code>/sku/<SKU>` (the short `/site/<SKU>.p` form failed in a browser).
- Best Buy: `productBySkuId` objects whose own `skuId` is the binding's SKU. Price is
  `price.customerPrice`. Stock is the `NEW` button state: `ADD_TO_CART`, `SOLD_OUT`, else
  unknown, and explicit `shippingEligible: false` never gives in-stock. First-party proof is
  `seller.classification` `1P` or `seller.id` `bby` with `marketplaceSeller` null; no seller
  data, another seller or any marketplace seller rejects. The page JSON-LD is never used
  because it said `InStock` while the product was sold out.
- Shipping and fees: the same owner-accepted assumption as Sony and Costco. When the
  binding's `shippingPolicyZips` lists the watch ZIP and the price is over $40, the offer takes
  free standard shipping (free over $35) and zero other mandatory fees, marked
  `policy-supported`. The owner's ceiling excludes the California recycling fee. The ship-to
  ZIP the retailer shows comes from the browser's IP address, not from the watch ZIP, and is
  not used. Without the ZIP in the list, shipping and fees stay unknown.

Fixtures `target-out-of-stock.json` and `bestbuy-out-of-stock.json` are trimmed copies of
real service-shaped responses captured 2026-11-03 (subtrees the parsers read, with
store addresses and the IP-derived ZIP removed). The `*-in-stock-synthetic.json` files are
synthetic: only the stock fields were edited.

The sample policy uses an example destination, not the owner's private policy.
Fixtures are factual subsets of public Sony/Costco responses captured October
30 PDT, 2026. They are dated snapshots, not current inventory or live tests.
In-stock scenarios in tests are explicitly synthetic.

## eBay collector preparation — disabled pending proof

The production Browse client is wired behind optional `EBAY_CREDENTIALS_FILE`,
read only by the integration worker. It accepts bounded credential JSON containing
exactly `clientId` and `clientSecret`. Tokens remain in memory; use the approved
SOPS pipeline for eventual mounted credentials, never arguments, logs or images.
No eBay credentials, enablement or deployment manifests are included here.

An enabled eBay binding requires an owner-configured exact `ebayGtin` equal to
`productId`. The worker independently checks the detail response identity, fixed
price, condition, seller and ZIP shipping. Warranty stays unknown, so only new
listings can qualify. Mandatory fees are an owner-accepted assumption (Nov 8): they count
as 0 only for a US, fixed-price, USD listing whose ZIP-echoed shipping option has a known
cost and no `importCharges`, with no `ecoParticipationFee`; otherwise they stay unknown.
Every eBay alert says "fee assumed, not verified". Unreviewed warnings fail closed, preserving evidence.

Tier 1 (no eBay seller identifier): the parser replaces the seller username with the fixed
label `eBay seller` and never reads any other seller id. Feedback percentage, score and account
type are kept. Discord text for eBay omits any seller name.

eBay gate: with an enabled eBay binding, each cycle reads `${EBAY_STATE_URL}/state` (an `http(s)`
origin, the receiver's internal port; 3 s timeout). A missing URL, timeout, error, a storage
design version other than `tier1-v1`, any state other than `CLEAR`, or a Tier 1 audit failure of
the eBay offers in `/api/dashboard` means BLOCKED: the eBay group is skipped before any lease,
eBay outbox events complete as `retry`/`compliance-blocked` with a one-hour delay, and the
integration status call carries `ebay: {state, reason}` so the dashboard shows "eBay paused".
Other retailers are unaffected.

SQLite in the app retains a bounded search/detail cursor. One search and each
item lookup require separate retailer-budget turns. Startup waits and shared
five-minute floors still apply. OAuth has memory reuse, a one-minute mint floor
and no automatic retry; a cold read can make one OAuth plus one Browse request
within the45second claim, each with15second timeout. At ten results the complete
cycle is at least55minutes, longer with jitter, retries or other watches. Offers
still expire after15minutes; do not describe this as five-minute full coverage.

The worker cache and sent-state are keyed by exact offer ID. After restart or
unmute, due pending alerts receive canonical refresh within the same source
budget, alternating with normal discovery work. Priority is capped after two
failed refreshes per offer/policy; normal detail tasks also advance after two
failures. Missing discovery results do not rearm alert fingerprints. The app and
worker share the same versioned domain module and fail closed on policy mismatch.
A failed item lookup invalidates only that listing's canonical cache entry. Failed
searches retain existing detail evidence without changing its observation time;
every delivery still requires independently fresh, qualifying detail evidence.
Malformed tasks and failures from single-offer sources invalidate the binding cache.

`scripts/probe-ebay.ts` is a separate one-shot investigation command. A dry run
requires no credentials or network:

```sh
bun scripts/probe-ebay.ts --mode item --id 123456789012 --zip 10001
```

Only explicit `--probe` reads bounded credential JSON from stdin and performs one
OAuth plus one Browse request. Output whitelists public evidence and excludes
credentials/raw response bodies. Search accepts a verified GTIN; item mode accepts
legacy or quoted REST item/variation IDs. Confirm Production Browse entitlement,
product identity and complete cost semantics before proposing source activation.

For a separately approved access check that must not emit listing values, include
`--technical-only`. Without `--probe`, this is still a credential-free/network-free
dry run:

```sh
bun scripts/probe-ebay.ts --mode search --id 123456789012 --zip 10001 --technical-only
```

The technical mode reports fixed access/schema predicates or generic failures
labelled by credentials, OAuth or Browse stage. It emits no listing values,
identifiers, seller details, response bodies, tokens or request URLs, and writes
no response files. Zero search results establish no item-identity schema evidence;
warnings and unsupported responses fail validation. Unknown, repeated or incomplete
flags are rejected before credentials or network work, including misspelled flags.
The existing mode without `--technical-only` emits item facts, including the seller
username, and is unsuitable for this no-values check. Neither technical output nor this command establishes
nonpersistence-exemption eligibility, seller/ZIP/cost qualification or approval
to read credentials, call Production, submit a declaration or activate a source.

## Trust and configuration

Required environment:

- `APP_BASE_URL`: fixed internal HTTPS origin, e.g. `https://deal-watch.local.<zone>`.
- `WATCH_CONFIG_FILE`: mounted owner-approved JSON `{policyVersion, watches}`.
- `EBAY_CREDENTIALS_FILE`: optional mounted eBay JSON, only for an approved eBay policy.
- `DISCORD_WEBHOOK_FILE`: mounted fixed Discord webhook, when delivery is enabled.

`ALLOW_LOCAL_HTTP=1` accepts localhost HTTP for isolated smoke tests only.
`RUN_ONCE=1` completes one cycle; startup still waits a full retailer interval
before any public fetch. No command bypasses the startup throttle.

The worker loads its own bounded watch IDs/product IDs/ZIPs/thresholds from a
private policy file, not from untrusted dashboard configuration. Export it from
the private app repository with that app's `scripts/export-policy.ts`. At the
separately approved credential step, put it in the worker's SOPS-managed Secret
alongside the designated shopping webhook. The public repository contains only
an example policy. No actual Secret, token or private policy is included here.

`src/vendor/domain.ts` is first-party shared source from the private apps
repository's `deal-watch/src/domain.ts`, kept byte-identical. No upstream tracker
source has been copied. The local cross-repository check compares it and tests
collection -> qualification -> queue -> mocked Discord -> durable acknowledgement.
The worker derives a canonical SHA-256 fingerprint of the complete approved policy,
reports it to the app, and checks it before collection/delivery. A mismatch is
visible in the dashboard and blocks collection and delivery. A policy change
requires matching reviewed configuration; app data cannot broaden the bounds.

All requests use fixed hosts, redirects disabled, response/time limits and
redacted failure codes. Retailer budgets are shared across watches; a round-robin
cursor prevents one product starving another. The worker independently enforces
request/backoff floors even if the app grants every claim. Startup waits a full
interval, while app SQLite also retains cooldowns across restarts. A claim must
be persisted before fetch; a failed app request stops further work for the cycle.

Outbox entries select configured identifiers only. The worker uses its own fresh
canonical cache and recomputes qualification and message text. Missing cache after
restart waits for revalidation inside the same retailer budget. Duplicate current
offers are suppressed; a canonical non-eligible observation rearms the episode.
Discord uses `wait=true`, validates the returned message ID and disables mentions.
Delivery is at least once: uncertain acceptance can cause duplicates carrying the
same event ID. Retry delays are bounded; attempt counts are unlimited and visible.
429 cooldowns apply across watches, persist in app SQLite and have a worker floor.

## Verify

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun scripts/protocol-test.ts /path/to/apps/deal-watch
docker build --platform linux/amd64 -t deal-watch-integrations:test .
bash scripts/smoke-worker.sh deal-watch-integrations:test
```

The worker smoke test uses uid 1000, read-only root, no external network, no real
credentials, an example policy and a loopback mock app. It exercises the actual
entrypoint. `/healthz` reports app-cycle readiness and whether Discord is configured;
it does not assert retailer availability. Source freshness/errors remain visible
in the dashboard. Credentials and upstream response bodies never enter logs.

Each attempted retailer check logs one line,
`{"event":"check","retailer":"sony","outcome":"ok","ms":412}`; `outcome` is `ok`, the
failure code (`access-denied`, `throttled`, `network`, `invalid-data`, `unsupported`), or
`not-product` (eBay only: the listing is not the watched product and is skipped).
An `invalid-data` line may add a fixed `reason` code. A `not-product` line always has one:
`gtin-mismatch`, or `gtin-missing:<product>:<condition>`, where `<product>` is
`no-product` or `no-gtins` and `<condition>` is `new`, `open-box`, `refurbished` or `other`.
The browser service logs one line per served `/observe` request,
`{"event":"observe","retailer":"target","status":200,"blocked":true,"reason":"captcha","net":null,"responses":2,"ms":31874}`;
`reason` is `captcha`, `block-text`, `timeout`, `navigation` or `null`, and `net` is
only a Chromium token such as `net::ERR_CONNECTION_RESET`, or `null`. Neither line
carries product IDs, prices, URLs, page text or error messages.

## Coordinated upgrade required

This worker and the multi-offer app use policy version `2026-11-04.1` (adds the `verify` availability and typed outbox events). The earlier
activation draft uses `2026-10-31.1`. Do not deploy these revisions separately:
review the app revision, published worker digest, activation image pin and mounted
policy exported from the matching app as one change set. Re-encrypt the matching
policy through the approved credential pipeline; never edit only its version string
without verifying the complete policy identity. Mismatches stop collection and
delivery; an old mounted version prevents worker startup.

The app upgrade migrates SQLite to schema 3 after taking a mandatory backup. A
previous image cannot read the newer schema. A rollback requires a reviewed restore
of the pre-migration database, with collection stopped and the restored app/worker/
policy versions matched. A registry image pin alone does not roll back data.
Merging the app PR publishes and deploys it through the platform; local validation
is not deployment approval. No deploying merge or credential change is authorized
by this document.

## Deployment draft — not activated

`deploy/` is intentionally outside the Flux-watched Kubernetes tree. It renders a
separate restricted namespace, one Recreate worker, no PVC, no service account
token, read-only mounted credentials and tmpfs. It exposes no Service/route.
Default-deny permits DNS, public HTTPS excluding private ranges, kubelet health
probes, and the existing internal Envoy proxy's port 10443. The app retains its
unchanged default-deny network policy and no outbound internet.

The template requires a real `DEAL_WATCH_WORKER_IMAGE` digest, the approved
`DEAL_WATCH_POLICY_ID` fingerprint (rollout annotation), and the existing
`SECRET_DOMAIN_LOCAL` substitution. It references, but does not create:

- `deal-watch-integrations-registry`: a separately encrypted registry pull Secret
  using the already-approved narrow read:packages pipeline, not Talos credentials.
- `deal-watch-integrations-credentials`: keys `watch-policy.json` and
  `discord-webhook`, mounted only here, never in a platform pod.

The workflow checks PRs and publishes only a checked main revision (or explicit
main dispatch) to `ghcr.io/<owner>/<homelab-repo>/deal-watch-integrations:sha-<sha>`.
Only the publishing job has packages:write. Deployments pin its resulting digest;
there is no moving tag or automatic worker rollout.

Before activation, obtain separate approval for exact deploying merges, registry
visibility/access, credential provisioning, worker image/policy, live gateway and
network tests, shopping-channel test delivery, source proof, backup and rollback.
Move/wire the reviewed template into Flux only in that activation change. No dummy
platform entry, policy exemption, browser session or new infrastructure is implied.
The app entry in this PR would deploy the dashboard if merged after its image is
published. The worker remains inactive until its own activation change.

The initial useful coverage is Sony-only until the Costco binding is enabled. Supported
Best Buy/eBay access and Target extraction remain required follow-up for the full
shopping request. This local-build draft does not complete that broader request.

Primary references: [Bun HTMLRewriter](https://bun.sh/docs/runtime/html-rewriter),
[Bun SQLite](https://bun.sh/docs/runtime/sqlite),
[Discord webhooks](https://docs.discord.com/developers/resources/webhook#execute-webhook).


`fixtures/sony-stock-comparison-20261101.json` is a factual subset captured
2026-11-02T03:48:03Z (November 1 locally) from Sony's public US
`/commercewebservices/ps-direct-us/products/productList?fields=BASIC&productCodes=1000050805,1000050328`.
PS5 Pro was explicitly `outOfStock` at USD899; white DualSense controller was
`inStock` at USD74 with ordinary ungated purchase flags. This corroborates the
positive stock spelling, not PS5 Pro stock, ZIP fulfillment or every possible
low-stock state. Unrecognized states still fail closed. No logged-in session,
cart or purchase was used, and the comparison controller is not enabled by policy.
