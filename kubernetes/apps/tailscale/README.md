# Family applications over Tailscale

## Direction — October 23, 2026

Use this as shared infrastructure for the family's applications: Jellyfin, Seerr,
Quilt Planner and future apps. Family members join the existing tailnet with their
own Tailscale accounts. Keep the existing broad access policy; per-app guest
sharing, `tag:quilts` and an app-specific egress policy are superseded.

This is the prepared family Services operator branch, with Quilt Planner as its
first app. The earlier standalone Quilt Planner Ingress and egress-policy PRs (#705 and #706) describe
that superseded design and must be revised before merging. Nothing here has been
deployed. The encrypted OAuth Secret has been generated and verified.

## Shared infrastructure

The operator creates one Tailscale Service per app. Each app gets a stable HTTPS
address, such as `jellyfin.<tailnet>.ts.net`, and all of them reuse ProxyGroup/apps.
Adding another app means adding its Ingress; it does not need a new operator,
proxy group, OAuth client or sharing invitation.

| Resource                       | Role                                                     |
| ------------------------------ | -------------------------------------------------------- |
| HelmRelease/tailscale-operator | Manages Tailscale resources for the cluster              |
| ProxyClass/apps                | Shared proxy resource settings                           |
| ProxyGroup/apps                | Two ingress proxy replicas serving all family apps       |
| Each app's Ingress             | Selects its name and existing Kubernetes Service backend |

Flux order is `tailscale-operator` → `tailscale-operator-config` → `tailscale-apps`.
App Kustomizations that introduce Tailscale Ingresses depend on `tailscale-apps`
in namespace `tailscale`.

The pinned operator's ProxyGroups use privileged kernel-network proxies. The
namespace permits that supported runtime, while the operator retains its own
non-root security context. ProxyClass/apps does not apply the incompatible
security settings from the previous standalone userspace proxy. Router
port-mapping remains disabled with `TS_DISABLE_PORTMAPPER=true`.

## One-time tailnet setup

1. Invite family members from the tailnet's Users page. They accept with their
   own accounts and select this tailnet in their Tailscale clients to use the
   apps. Normal clients connect to one tailnet at a time, so someone using their
   own tailnet switches between it and this one.
2. Enable MagicDNS and HTTPS certificates (HTTPS is already confirmed by the user).
3. Merge these entries into the existing policy, preserving its grants and any
   unrelated tagOwners, autoApprovers, SSH or other settings:

    ```json
    "tagOwners": {
      "tag:k8s-operator": ["autogroup:admin"],
      "tag:k8s": ["tag:k8s-operator"]
    },
    "autoApprovers": {
      "services": {
        "tag:k8s": ["tag:k8s"]
      }
    }
    ```

    Both the proxy devices and their Tailscale Services use `tag:k8s`. The
    auto-approver lets these proxies advertise current and future app Services.
    Keep the user's existing `src: ["*"], dst: ["*"], ip: ["*"]` grant. There is
    no per-app family restriction to add.

4. The operator OAuth client needs Write on General/Services, Devices/Core and
   Keys/Auth Keys, all scoped to `tag:k8s-operator`.
5. Store the client ID and secret in `Private/Tailscale Home Kubernetes`, fields
   `client_id` in section `Client ID` and `client_secret` in section
   `Client Secret`. Both fields are verified. The template uses stable item and
   field IDs so later display-name changes do not break secret generation.

## OAuth Secret

With 1Password CLI access working, run `just tailscale oauth-secret` from the
worktree root. It pipes 1Password values directly into SOPS, validates decryption
without printing plaintext, then atomically writes `secret.sops.yaml`.

The generated `./secret.sops.yaml` is included in
`tailscale-operator/app/kustomization.yaml`. The app uses the SOPS
configuration inherited through Flux. No cluster-wide secrets component is
copied into this namespace.

## Add an application

Put a Tailscale Ingress alongside the app's own manifests, in the same namespace
as its backend Service. For example, replace `my-app`, `app-namespace` and port
`80` with the app's actual values:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
    name: my-app-tailnet
    namespace: app-namespace
    annotations:
        tailscale.com/proxy-group: apps
spec:
    ingressClassName: tailscale
    tls:
        - hosts:
              - my-app
    defaultBackend:
        service:
            name: my-app
            port:
                number: 80
```

The operator creates the app's Tailscale Service, configures HTTPS and adds it to
the existing shared proxies. The ADDRESS on the Ingress gives its actual URL.
The backend is the app's Service directly; existing LAN HTTPRoutes can coexist.
Use `<tailnet>` and `<zone>` placeholders in tracked documentation.

App configuration remains separate: publishing Jellyfin also requires deploying
Jellyfin, and app logins behave as configured by each app. This infrastructure
provides private connectivity for all family applications.

## Delivery and verification

- This branch includes the merged validator corrections from #703.
- Check the operator, ProxyClass/apps and ProxyGroup/apps are Ready before the
  first app Ingress is introduced.
- Check the Tailscale Service is advertised and its HTTPS URL works from a
  family account connected to this tailnet, including after a proxy pod restart.
- These two replicas protect against a proxy pod restart, not a Hobbes outage.

## Rollback

Remove app Ingresses first and let the operator clean up their Services. Then
remove `tailscale-apps` and its proxies directory; wait for the ProxyGroup and
proxy pods to disappear. Remove the ProxyClass stage next while the operator
still runs, and uninstall the operator last. The existing Helm CRD keep policy
and namespace prune protection remain in place.

## References

- [Shared ingress ProxyGroups](https://tailscale.com/docs/kubernetes-operator/concepts/proxygroup)
- [L7 application ingress](https://tailscale.com/docs/kubernetes-operator/ingress/expose-workload-to-tailnet-l7)
- [Operator permissions and Service auto-approval](https://tailscale.com/docs/kubernetes-operator/reference/rbac)
- [OAuth setup](https://tailscale.com/docs/kubernetes-operator/install-operator)
- [Invite family members](https://tailscale.com/docs/features/sharing/how-to/invite-any-user)
