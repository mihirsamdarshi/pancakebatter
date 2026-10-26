# Family apps from separate tailnets

Family members keep their own accounts and remain connected to their own
tailnets. One shared `family-apps` node forwards HTTPS to a dedicated Envoy
Gateway, `envoy-family`. Every app uses its own hostname under
`${SECRET_FAMILY_DOMAIN}` (`family.<zone>`); the single gateway share covers
current and future apps. The previous names under `family.${SECRET_DOMAIN}`
(`family.local.<zone>`) keep working during a transition.

## Internal-only apps stay unreachable

`envoy-family` is a second Gateway (same GatewayClass, its own proxy pods) with
HTTPS listeners restricted to `*.${SECRET_FAMILY_DOMAIN}` (`https`) and, during
the transition, `*.family.${SECRET_DOMAIN}` (`https-legacy`). The `family-apps`
Service selects only its pods, so a family tailnet can never reach
`envoy-internal`, where the internal-only routes (Grafana, Flux webhook, future
Sonarr, Radarr, qBittorrent) are attached. Hostname matching alone would not
hold that line: the shared node would forward any Host header to the same
proxies. Two rules keep it enforced:

- Attach a family route **only** to `envoy-family` (parentRef name and
  namespace, no `sectionName`, so each hostname lands on its own listener), and
  only with `<app>.${SECRET_FAMILY_DOMAIN}` plus, during the transition,
  `<app>.family.${SECRET_DOMAIN}` hostnames. Do not also attach it to
  `envoy-internal`.
- Never point the `family-apps` selector at `envoy-internal`.

`envoy-family`'s Service is `ClusterIP` (per-Gateway `EnvoyProxy` that merges
over the shared one): the Tailscale Service targets the pods directly, so it
needs no Cilium LoadBalancer IP. Its pods carry the same labels as
`envoy-internal`'s, so the existing PodMonitor scrapes them.

This is Tailscale **device sharing**, not a tailnet membership invitation and
not a ProxyGroup Tailscale Service. Do not add `tailscale.com/proxy-group` to
this Service: it must remain a standalone shareable node. Existing LAN routes
and the in-tailnet Services ProxyGroup remain available.

The standalone proxy requires Cilium's `socketLB.hostNamespaceOnly: true` when
kube-proxy replacement is enabled. Otherwise the node can be reachable while
TCP forwarding to the Service times out. Cilium updates roll one agent at a time.

## HTTPS and DNS

- Service `network/family-apps` forwards TCP 443 to `envoy-family`'s port 10443
  (Envoy Gateway maps listener port 443 to container port 10443).
- `envoy-family` terminates HTTPS with its own cert-manager Certificates, one
  Secret per listener: `family-production` (Secret `family-production-tls`) for
  `*.${SECRET_FAMILY_DOMAIN}` on `https`, and `family-legacy-production` (Secret
  `family-legacy-production-tls`) for `*.family.${SECRET_DOMAIN}` on
  `https-legacy`, and `family-landing-production` (Secret
  `family-landing-production-tls`) for the bare `${SECRET_FAMILY_DOMAIN}` on
  `https-landing`. Two listeners must not share a Secret: Envoy Gateway reports
  overlapping TLS config, and with h2 enabled a browser could reuse one
  connection across both names and get a 404. The shared wildcard used by
  `envoy-internal` carries no family names, so the internal Gateway never
  presents a certificate for them. Until the Secrets exist, `envoy-family` has no
  certificate and serves no TLS.
- `${SECRET_FAMILY_DOMAIN}` is a `cluster-secrets` variable (`family.<zone>`,
  derived from the zone). It is outside the ClusterIssuer's `${SECRET_DOMAIN}`
  zone, so the ClusterIssuer's DNS-01 solver must list it in `dnsZones` too
  (delivered as a separate change; it must be live before these Certificates
  can be issued).
- Terraform's separate DNS root manages unproxied A records for
  `*.family.<zone>`, the bare `family.<zone>` (homepage) and, during the
  transition, `*.family.local.<zone>`, all pointing at the standalone node's
  Tailscale IPv4. Set `family_gateway_ip` in an ignored local tfvars file after
  provisioning.
- The existing `*.local.<zone>` record keeps its LAN gateway address.
- Quilt Planner's routes are `https://quilts.family.<zone>` and the previous
  `https://quilts.family.local.<zone>`. Future apps add an HTTPRoute on
  `envoy-family`; no new share, DNS record or certificate.
- The route is not also attached to `envoy-internal`: LAN clients resolve
  `*.family` to the Tailscale address anyway. `k8s-gateway` would answer a
  family hostname with `envoy-family`'s ClusterIP, so do not point split DNS at
  it for `*.family` names.
- Retire the legacy names together: the `https-legacy` listener, the
  `family-legacy-production` Certificate, the `family_wildcard` DNS record, the
  legacy hostname on the `family-not-found` route and each app route's legacy
  hostname.

## Home page and unknown names

`envoy-family` has a third listener, `https-landing`, for the bare
`${SECRET_FAMILY_DOMAIN}` name that the wildcard listener does not cover. The
family homepage attaches its HTTPRoute there; this listener has no route of its
own. It has its own Certificate `family-landing-production`, not a SAN on
`family-production`: Envoy Gateway flags overlapping certificate SANs between
listeners, and the shared ClientTrafficPolicy sets ALPN `h2` explicitly, so a
browser going from the homepage to an app could reuse the connection and get a
404.

The `network/fallback-pages` Kustomization serves small self-contained 404 pages
straight from Envoy (Envoy Gateway `HTTPRouteFilter` `directResponse`, body from
a ConfigMap built from the `.html` files in `fallback-pages/app/`):

- Any name under `*.family.<zone>` (and the legacy `*.family.local.<zone>`) that
  no app route claims answers 404, linking to the family home and the family
  apps. The route's hostnames are the listeners' wildcards, so an app's exact
  hostname is always the more specific match and keeps winning.
- On the LAN gateway, any other name under `*.local.<zone>` answers 404, linking
  to `home.<internal zone>` and the internal apps. The exact routes (Grafana,
  Jellyfin, Quilts, echo, Flux webhook, the internal homepage) win over it.

When an app is added, add a link to the pages it belongs on
(`family-not-found.html` for family apps, `internal-not-found.html` for LAN
apps). The page body is an Envoy format string: keep percent signs out of it.
`k8s-gateway` reads HTTPRoute hostnames, so the internal wildcard makes it answer
unknown `*.local.<zone>` names with the `envoy-internal` address (the same
address the Terraform wildcard record gives). The legacy wildcard likewise
yields `envoy-family`'s ClusterIP, like every existing legacy name, which is why
split DNS must not point `*.family` at it.

## Device roles

- `tag:router`: the two routers providing routing/exit-node functions.
- `tag:home`: shared home devices (NAS, Apple TV) and this family app gateway.
- The gateway also retains `tag:k8s`; internal operator/proxy roles stay intact.
- Apple TV is not being enabled as an exit node.

The operator must own `tag:home` through `tagOwners`, in addition to family tag
owners. The Service declares `tag:k8s,tag:home` for future provisioning.
Tailscale does not retag an existing proxy when this annotation changes: update
the existing gateway device's tags separately, preserving its identity, IP,
state Secret and shares. Do not recreate it to change tags.

Ordinary device sharing is the approved family method. Router shares can grant
exit-node use; home-device and app-gateway shares do not enable exit-node use.
Each person accepts a share into their own tailnet. Existing accepted or pending
shares must be checked before creating another invitation. Friends' service-only
access is future work and is not part of this setup.

## Share once with each family member

1. Find `family-apps` on the admin console's **Machines** page.
2. Choose **Share**, then **Copy invite link**. Send each person a single-use
   device-share link, or use a reusable link for the intended family recipients.
3. They accept while signed in to their existing Tailscale accounts, choosing
   their own tailnets. They do not join or switch to this tailnet.
4. With Tailscale connected to their own tailnet, open Quilt Planner's family
   HTTPS address and verify the page loads and `/api/health` returns `ok`.

The operator OAuth client can provision the gateway but cannot create device
share invitations: Tailscale's API requires user-scoped credentials for that
operation. Use the signed-in admin console; do not broaden the operator scopes.
The existing allow-all grant permits incoming shared users. No additional
per-app access policy is required. Recipient clients must be user-owned devices.

Only actual acceptance and a request from a recipient's own tailnet establish
cross-tailnet access. Owner-side HTTPS checks verify the gateway and certificate
but do not prove the sharing step is complete. Sharing can rarely remap a node's
100.x address in a recipient tailnet; diagnose that if DNS resolves but access
fails, rather than changing the recipient's tailnet membership.

## Flux and verification

`network/family-apps` depends on the operator's validated ProxyClass and the
`envoy-gateway` Kustomization, which creates `envoy-family`. That Kustomization
does not wait for the proxy pods or the new Certificates, so the Service
selector can switch before they are Ready; the family endpoint stays empty
until they are, and Envoy Gateway does not create `envoy-family`'s proxy pods
until its Secrets exist (expect about two to four minutes of family downtime).
If a Certificate's Order fails, `cmctl renew family-production` (or
`family-legacy-production`) retries it.
`network/quilt-planner-family` reads the existing domain Secret in `network`
and creates its HTTPRoute in `quilt-planner`, depending on both the gateway and
the existing app. No credentials are copied into the app namespace.

Before delivery, verify the `family-production` and `family-legacy-production`
Certificates are Ready, the
`envoy-family` Gateway is Programmed with two Ready proxy pods (named
`envoy-family-*`), the `family-apps` Service has endpoints on port 10443, the
Service has a Tailscale address, the standalone proxy is Ready, the route has
Accepted/ResolvedRefs conditions on `envoy-family`, and HTTPS works with normal
certificate verification on both family names.
Then confirm the boundary: through the family address, a request for an
internal-only hostname (for example `grafana.local.<zone>` sent with
`curl --resolve` to the family IP, or a forced `Host` header) must fail the TLS
handshake or return 404 or 421, never the app.
After sharing, repeat the HTTPS check from a recipient's own tailnet.

## Sources

- [Device sharing](https://tailscale.com/docs/features/sharing)
- [Shared tagged devices](https://tailscale.com/docs/reference/examples/acls)
- [Standalone operator proxies](https://tailscale.com/docs/kubernetes-operator/concepts/architecture)
- [Tailscale API](https://tailscale.com/api)
