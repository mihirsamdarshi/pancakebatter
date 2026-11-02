# Deal Watch integrations

Outbound collection and fixed-channel Discord delivery for the credential-free
Deal Watch app. This is infrastructure outside the personal app platform.
No browser runtime, retailer login state, generic URL proxy or purchasing is included.

## Implemented and gated

Sony Direct's public website product response is parsed by exact product ID,
USD price and explicit stock fields. It is a website backend, not a promised
stable developer API. Out-of-stock wins over purchasable; order limits are not
inventory. Preorder, gated or incomplete responses cannot qualify. A reviewed
shipping-policy ZIP allowlist can establish policy-supported free standard
shipping above $40; it never establishes ZIP-specific checkout availability.

Costco Product JSON-LD is parsed by exact SKU and one unambiguous offer.
Shipping, membership fees and component references remain unknown, so it cannot
produce a qualifying offer yet. It is disabled in the owner's current policy.
Best Buy, Target and eBay are also disabled pending access/extraction proof;
there is no claim that these sources are implemented or continuously monitored.

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
price, condition, seller and ZIP shipping. Missing mandatory fees and warranty
stay unknown. This adapter currently cannot produce qualifying eBay alerts until
cost proof is established. Unreviewed warnings fail closed, preserving evidence.

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

## Coordinated upgrade required

This worker and the multi-offer app use policy version `2026-11-01.1`. The earlier
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

The initial useful coverage is Sony-only. Costco bundle qualification, supported
Best Buy/eBay access and Target extraction remain required follow-up for the full
shopping request. This local-build draft does not complete that broader request.

Primary references: [Bun HTMLRewriter](https://bun.sh/docs/runtime/html-rewriter),
[Bun SQLite](https://bun.sh/docs/runtime/sqlite),
[Discord webhooks](https://docs.discord.com/developers/resources/webhook#execute-webhook).
