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

## Trust and configuration

Required environment:

- `APP_BASE_URL`: fixed internal HTTPS origin, e.g. `https://deal-watch.local.<zone>`.
- `WATCH_CONFIG_FILE`: mounted owner-approved JSON `{policyVersion, watches}`.
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
