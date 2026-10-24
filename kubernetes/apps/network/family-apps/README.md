# Family apps from separate tailnets

Family members keep their own accounts and remain connected to their own
tailnets. One shared `family-apps` node forwards HTTPS to the existing Envoy
gateway. Every app uses its own hostname under `family.${SECRET_DOMAIN}`;
the single gateway share covers current and future apps.

This is Tailscale **device sharing**, not a tailnet membership invitation and
not a ProxyGroup Tailscale Service. Do not add `tailscale.com/proxy-group` to
this Service: it must remain a standalone shareable node. Existing LAN routes
and the in-tailnet Services ProxyGroup remain available.

The standalone proxy requires Cilium's `socketLB.hostNamespaceOnly: true` when
kube-proxy replacement is enabled. Otherwise the node can be reachable while
TCP forwarding to the Service times out. Cilium updates roll one agent at a time.

## HTTPS and DNS

- Service `network/family-apps` forwards TCP 443 to Envoy's port 10443.
- Envoy terminates HTTPS with the existing cert-manager-managed certificate,
  extended with `*.family.${SECRET_DOMAIN}`. Its existing `*.${SECRET_DOMAIN}`
  already covers `family.${SECRET_DOMAIN}`; repeating that exact name would
  make the ACME order redundant and fail issuance.
- Terraform's separate DNS root manages one unproxied wildcard A record for
  `*.family.local.<zone>`, pointing at the standalone node's Tailscale IPv4.
  Set `family_gateway_ip` in an ignored local tfvars file after provisioning.
- The existing `*.local.<zone>` record keeps its LAN gateway address.
- Quilt Planner's new route is `https://quilts.family.local.<zone>`. Future apps
  add an HTTPRoute on the existing HTTPS Gateway; no new share or DNS record.

The gateway is a single persistent Tailscale node backed by a standalone proxy
pod; its Kubernetes state Secret must be preserved. It is not the two-replica
Services ProxyGroup. Existing Envoy backends retain two replicas.

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

`network/family-apps` depends on the operator's validated ProxyClass and Envoy.
`network/quilt-planner-family` reads the existing domain Secret in `network`
and creates its HTTPRoute in `quilt-planner`, depending on both the gateway and
the existing app. No credentials are copied into the app namespace.

Before delivery, verify the Service has a Tailscale address, the standalone proxy
is Ready, the route has Accepted/ResolvedRefs conditions, the certificate covers
the family hostname, and HTTPS works with normal certificate verification.
After sharing, repeat the HTTPS check from a recipient's own tailnet.

## Sources

- [Device sharing](https://tailscale.com/docs/features/sharing)
- [Shared tagged devices](https://tailscale.com/docs/reference/examples/acls)
- [Standalone operator proxies](https://tailscale.com/docs/kubernetes-operator/concepts/architecture)
- [Tailscale API](https://tailscale.com/api)
