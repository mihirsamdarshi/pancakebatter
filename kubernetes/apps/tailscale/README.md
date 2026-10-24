# Tailscale operator

The Tailscale Kubernetes operator (chart `tailscale-operator`) runs in its own `tailscale`
namespace. Its only job is to put Quilt Planner on the tailnet as the device `quilts`, so that
it can be shared with one outside user. Nothing here is public: there is no Funnel, no
LoadBalancer Service and no HTTPRoute.

| Path                                      | Flux Kustomization          | Contents                                          |
| ----------------------------------------- | --------------------------- | ------------------------------------------------- |
| `tailscale-operator/app`                  | `tailscale-operator`        | HelmRepository, HelmRelease, OAuth SOPS Secret    |
| `tailscale-operator/config`               | `tailscale-operator-config` | ProxyClass `quilts`                               |
| `../quilt-planner/tailnet`                | `quilt-planner-tailnet`     | Ingress `quilt-planner-tailnet` (device `quilts`) |
| `tailscale-operator/config` (egress file) | `tailscale-operator-config` | CiliumNetworkPolicy `quilts-proxy-egress`         |

Order: `tailscale-operator` → `tailscale-operator-config` → `quilt-planner-tailnet`. The
operator, the Ingress and the egress policy land in three separate PRs, in that order. The repo
squash-merges, so separate PRs are what make the stepwise rollback below possible.

In these notes, `<tailnet>` stands for the tailnet DNS name. Do not write the real name, or the
real domain, in this repository.

## Prerequisites (tailnet admin console)

- HTTPS certificates and MagicDNS are on.
- The policy has the tagOwners `tag:k8s-operator: []`, `tag:k8s: [tag:k8s-operator]` and
  `tag:quilts: [tag:k8s-operator]`, plus one grant: `autogroup:shared` → `tag:quilts`, `tcp:443`.
- No device is already called `quilts` or `tailscale-operator`. If one is, the new device gets a
  `-1` suffix.
- An OAuth client (Settings → Trust credentials) with Write on Devices → Core and Keys → Auth
  Keys only, tagged `tag:k8s-operator`. Store its ID and secret only in the 1Password item
  `Private/Tailscale K8s Operator OAuth`, in the fields `client_id` and `client_secret`.

## OAuth Secret

The operator reads `tailscale-operator-oauth` (keys `client_id` and `client_secret`). Generate
the Secret from 1Password with a signed-in `op`. It never prints or writes the plaintext:

```sh
just tailscale oauth-secret
```

The recipe runs `op inject` on `tailscale-operator/app/secret.yaml.tpl`, pipes the result into
`sops encrypt`, decrypts it once to check it, and only then replaces `secret.sops.yaml`. When you
create the file for the first time, uncomment `./secret.sops.yaml` in
`tailscale-operator/app/kustomization.yaml`. Until the Secret exists, the operator pod cannot
start.

### Exposure

The chart gives the proxy ServiceAccount (`proxies`) full access to every Secret in the
`tailscale` namespace. A proxy pod can therefore read the operator OAuth Secret. This is
accepted. The proxy egress policy limits where a compromised proxy can send it, and rotation is
quick.

### Rotation runbook

Rotate when the secret may have leaked, or at least once a year.

1. In Trust credentials, create a new OAuth client with the same scopes and tag.
2. Replace `client_id` and `client_secret` in the 1Password item.
3. Run `just tailscale oauth-secret`, then commit and push.
4. Check that Flux applied it, then restart the operator:
   `kubectl -n tailscale rollout restart deploy/operator`.
5. Check the operator logs for OAuth errors and confirm that `quilts` is still online.
6. Revoke the old OAuth client.

Existing proxy devices keep their node keys, so rotation does not recreate `quilts` and does not
break the share.

## Rollback

Undo by editing files, in this order, and push each step on its own. Do not revert the PRs in
one go: the operator must still be running while the Ingress and the ProxyClass are deleted,
because it holds a finalizer on each and is what deletes the proxy and the device.

1. **Ingress.** Delete the `quilt-planner-tailnet` Kustomization document from
   `kubernetes/apps/quilt-planner/ks.yaml` (and the `tailnet/` directory). Flux prunes the
   Ingress and the operator removes the proxy and the device. Wait until all of these hold:
    - `kubectl -n quilt-planner get ingress quilt-planner-tailnet` returns NotFound;
    - `kubectl -n tailscale get sts -l tailscale.com/parent-resource=quilt-planner-tailnet`
      returns nothing;
    - `quilts` is no longer in the admin console Machines list.
2. **Egress policy.** Remove `./ciliumnetworkpolicy.yaml` from
   `tailscale-operator/config/kustomization.yaml` and delete the file.
3. **Operator.**
    1. Delete the `tailscale-operator-config` Kustomization document from
       `tailscale-operator/ks.yaml` while the operator is still running. Wait until
       `kubectl get proxyclass quilts` returns NotFound.
    2. Then delete the `kubernetes/apps/tailscale` directory and the `tailscale` module line in
       the root `justfile`. Flux uninstalls the HelmRelease. The `tailscale.com` CRDs stay,
       because of `helm.sh/resource-policy: keep`, and so does the namespace (prune disabled).
4. In the console, delete the `tailscale-operator` device and revoke the OAuth client.
5. Optional, after review: delete the leftover state Secrets in `tailscale`, the namespace and the
   `tailscale.com` CRDs by hand.

### Break-glass: stuck finalizers

If the operator is already gone, nothing removes its finalizers, and Flux waits forever
(`deletionPolicy: WaitForTermination`). Remove them by hand.

Ingress:

```sh
kubectl -n quilt-planner patch ingress quilt-planner-tailnet --type=merge -p '{"metadata":{"finalizers":null}}'
```

ProxyClass:

```sh
kubectl patch proxyclass quilts --type=json -p='[{"op":"remove","path":"/metadata/finalizers"}]'
```

Then clean up what the operator would have deleted:

- the `quilts` device in the console;
- the StatefulSet, Secrets and other objects labelled
  `tailscale.com/parent-resource=quilt-planner-tailnet` in `tailscale`.

## Emergency stop

Revoking the share in the console (Machines → `quilts` → Share → Revoke) is the **only**
immediate stop. It takes seconds and changes nothing in the cluster.

Removing the `autogroup:shared` grant from the policy does **not** cut the shared user off while
the policy still has its `"*"` source rules: `"*"` includes `autogroup:shared`. Deleting the
Ingress (rollback step 1) also works, but only after a push and a Flux reconcile.

## Certificate Transparency

HTTPS on the tailnet uses a public Let's Encrypt certificate, so the name
`quilts.<tailnet>.ts.net` appears in public Certificate Transparency logs. That reveals the
tailnet DNS name and the device name. It grants no access, but do not treat either name as
secret.

## Sharing

The share belongs to the device. The device name `quilts`, the Ingress name
`quilt-planner-tailnet` and the `tailscale.com/tags` annotation must never change. Any of these
changes creates a new device, which drops the share. A new name is also a new HTTPS origin, so
offline data stored under the old one is stranded.

### Re-share runbook

Use this when the device was recreated, or when the share was revoked by mistake.

1. Check that the shared user has nothing left to sync offline (open the app while connected).
2. If `quilts` was recreated, delete any stale `quilts` machine in the console **first**, then
   delete the proxy pod (`kubectl -n tailscale delete pod -l
   tailscale.com/parent-resource=quilt-planner-tailnet`) so that it registers as `quilts`, not
   `quilts-1`.
3. Check `kubectl -n quilt-planner get ingress quilt-planner-tailnet`: the address must be
   `quilts.<tailnet>.ts.net`.
4. Machines → `quilts` → Share → Copy invite link, **single use**. Send it over a private channel.
5. After the user accepts, check that their account is listed in the Share dialog, and that
   `https://quilts.<tailnet>.ts.net` loads on their device.

### Monthly share audit

1. Machines → `quilts` → Share: only the expected account is listed, and there are no unused
   pending invites. Revoke anything else.
2. Machines: `quilts` carries `tag:quilts` only, and has no `-1` twin. There are no stale `tag:k8s*`
   devices.
3. Access controls: the `autogroup:shared` grant is still `tag:quilts`, `tcp:443`, and no
   `funnel` nodeAttr covers `tag:quilts`, `tag:k8s` or `tag:k8s-operator`.
4. Trust credentials: only the current operator OAuth client exists, with the expected scopes.
5. Cluster: `kubectl -n tailscale get pods` shows the operator and one proxy, both Running with
   few restarts. `flux get ks -A` shows the three Kustomizations above as Ready.
6. Events: Warning events on ProxyClass `quilts` with reason `CustomTSEnvVar` are expected. The
   operator emits one on every reconcile because the class sets `TS_DISABLE_PORTMAPPER`. Ignore
   them.

## Follow-ups (not implemented)

- An egress CiliumNetworkPolicy for the operator pod itself (DNS, kube-apiserver, Tailscale
  control and DERP on the public internet only), like the one for the `quilts` proxy.
