# Claude proxy

**Activation proposal.** Do not merge or apply before complete validation,
independent review and owner approval. This folder is not ready to merge yet:

- `app/kustomization.yaml` lists two SOPS files that the owner creates
  (steps 2 and 3 below). Until they exist, `scripts/validate-kubernetes.sh`
  fails at `kustomize build` and Flux cannot build the app.
- `app/deployment.yaml` pins a **placeholder digest** (all zeros). The image
  does not exist until the workflow publishes it from main (step 1).

The Flux Kustomization has `wait: true`, so if this folder is merged early it
stays not ready, and Flux reports the failure, until both are fixed.

## What it deploys

One restricted namespace, `claude-proxy`, outside the personal app platform:

- one Deployment (one replica, `Recreate`), uid 1000, read-only root, all
  capabilities dropped, no service-account token, no PVC, memory limit 512Mi
  (room for four requests in progress with bodies up to 16 MB);
- a ClusterIP Service `claude-proxy` on port 3000, with no route or gateway;
- the API key from the Secret `claude-proxy-credentials` (key
  `anthropic-api-key`), mounted read-only at `/run/credentials`, mode 0440;
- a pull Secret `claude-proxy-registry` with a read-only GHCR credential;
- a CiliumNetworkPolicy. Ingress: port 3000 from the app pods of the reports
  and job-tracker platform apps only (label `app.kubernetes.io/name: <app>` in
  the namespace of the same name, not their scheduled jobs, export jobs or
  other pods) and from the node (kubelet probes). Egress:
  cluster DNS, and port 443 on Anthropic's published inbound IPv4 ranges only,
  `160.79.104.0/23` and `153.61.224.0/22`
  ([IP addresses](https://platform.claude.com/docs/en/api/ip-addresses),
  checked 2026-11-03). The cluster uses no FQDN rules; the proxy's code also
  sends requests only to `https://api.anthropic.com`.

How the proxy works, its limits and its configuration are in
`integrations/claude-proxy/README.md`. In short: it allows four requests at a
time, refuses models outside `ALLOWED_MODELS` and request fields that change the
price, and reserves each request's estimated maximum cost before sending it. A
request whose estimate does not fit under `DAILY_CAP_USD` (20) for the UTC day,
beside the spend so far and the reservations of requests in progress, is
refused with 403. The spend count survives a container restart but not a new
pod, so also set a spend limit in the Anthropic Console.

## Owner steps before activation

Run every command from the repository root, in bash or zsh, with the repo's
mise tools on the `PATH` (or prefix each tool with `mise exec --`).

### 1. Publish the image and pin its digest

Merge `integrations/claude-proxy/` and `.github/workflows/claude-proxy.yaml`
first, in a change without this folder. The push to main publishes
`ghcr.io/<owner>/<homelab-repo>/claude-proxy:sha-<sha>`. Read its digest from
the "Publish proxy" job log (the `digest: sha256:...` line), or with a token
that has `read:packages`:

```sh
gh api "/users/<owner>/packages/container/<homelab-repo>%2Fclaude-proxy/versions" \
  --jq '.[] | select(.metadata.container.tags | index("sha-<sha>")) | .name'
```

Replace the zeros in `app/deployment.yaml` with that digest, and delete the
placeholder comment above the `image:` line.

### 2. Create `app/credentials.sops.yaml` (the API key)

Use a key made only for this proxy, so it can be revoked alone. A Console
workspace with its own spend limit is the best place for it.

The plaintext key is never written to a file: `sops encrypt` reads it from the
pipe and writes to `<file>.tmp`. Only when every stage succeeded and the output
holds `ENC[` does `mv` put it in place. A failure leaves no new file and keeps
an existing one. The subshell keeps `pipefail` out of your shell. Replace the
`op://` reference with the 1Password item that holds the key:

```sh
( set -o pipefail
  f=kubernetes/apps/personal-apps/claude-proxy/app/credentials.sops.yaml
  op read 'op://<vault>/<item>/<field>' \
    | kubectl create secret generic claude-proxy-credentials --namespace claude-proxy --from-file=anthropic-api-key=/dev/stdin --dry-run=client -o yaml \
    | yq '.type = "Opaque" | .stringData = (.data | map_values(@base64d)) | del(.data) | del(.metadata.creationTimestamp)' \
    | sops encrypt --filename-override "$f" --input-type yaml --output-type yaml /dev/stdin > "$f.tmp" \
    && grep -q 'ENC\[' "$f.tmp" && mv "$f.tmp" "$f" || { rm -f "$f.tmp"; echo "failed: $f was not written" >&2; false; } )
```

`--filename-override` makes sops apply the `.sops.yaml` rule for that path,
which encrypts `data` and `stringData` only. A trailing newline from `op read`
is harmless: the proxy trims the key.

Check the shape only, never the value:

```sh
sops decrypt kubernetes/apps/personal-apps/claude-proxy/app/credentials.sops.yaml | yq '.stringData | keys'
# - anthropic-api-key
sops decrypt kubernetes/apps/personal-apps/claude-proxy/app/credentials.sops.yaml | yq '.stringData["anthropic-api-key"] | length'
# the key's length, not 0
```

### 3. `app/registry.sops.yaml` (read-only GHCR pull credential)

This is a copy of `personal-apps/deal-watch/integrations/app/registry.sops.yaml` with only
`metadata.name` and `metadata.namespace` changed. It pulls from the same
`ghcr.io/<owner>/<homelab-repo>/*` packages. The repo's sops rule sets
`mac_only_encrypted`, so the MAC covers the encrypted value only and the
copy decrypts without re-encryption. To make it again (no plaintext involved):

```sh
yq '.metadata.name = "claude-proxy-registry" | .metadata.namespace = "claude-proxy"' \
  kubernetes/apps/personal-apps/deal-watch/integrations/app/registry.sops.yaml \
  > kubernetes/apps/personal-apps/claude-proxy/app/registry.sops.yaml
```

When the deal-watch token is rotated, copy it again. To give the proxy its own
token instead, use the `kubectl create secret docker-registry` pipeline from
`personal-apps/README.md` ("Creating ghcr-apps-read") with this file's name and
namespace.

Check the shape only:

```sh
sops decrypt kubernetes/apps/personal-apps/claude-proxy/app/registry.sops.yaml | yq '.type'
# kubernetes.io/dockerconfigjson
```

### 4. Validate

```sh
git status --short kubernetes/apps/personal-apps/claude-proxy   # the two .sops.yaml files, no .tmp file
bash scripts/validate-kubernetes.sh
```

It passes only when both SOPS files exist.

### 5. Let the reports and job-tracker apps reach the proxy

This policy admits only the app pods of two platform apps, reports and
job-tracker: the label `app.kubernetes.io/name: <app>` that the platform's base
Deployment sets, in the namespace of the same name. Both entries set
`egress: claude-proxy`, a platform egress mode that adds only these pods on
3000/TCP to the app's default-deny policy
(`kubernetes/components/app-platform/netpol-egress-claude-proxy/`). Each app
calls `http://claude-proxy.claude-proxy.svc.cluster.local:3000` and sends a
placeholder key that this proxy replaces, so neither app namespace holds a key.
The two apps share the one `DAILY_CAP_USD`. To admit another app, add a
`matchLabels` item for it to the policy's `fromEndpoints` list, in a reviewed
change.

## Checks after the merge

```sh
flux get ks claude-proxy -n flux-system
kubectl -n claude-proxy get deploy,pod,svc
kubectl -n claude-proxy logs deploy/claude-proxy   # a "listening" line; never a key
```

A free upstream test (token counting is not billed) proves the key and the
egress path:

```sh
kubectl -n claude-proxy exec deploy/claude-proxy -- bun -e '
  const r = await fetch("http://127.0.0.1:3000/v1/messages/count_tokens", {method: "POST",
    headers: {"content-type": "application/json", "anthropic-version": "2023-06-01"},
    body: JSON.stringify({model: "claude-haiku-5-5", messages: [{role: "user", content: "hi"}]})});
  console.log(r.status, await r.text());'
# 200 {"input_tokens":...}
kubectl -n claude-proxy exec deploy/claude-proxy -- bun -e '
  console.log(await (await fetch("http://127.0.0.1:3000/usage")).text())'
```

If requests fail with 502 after a connection timeout while DNS and the key
are fine, check whether Anthropic's published ranges have changed, and update
`app/networkpolicy.yaml`. The policy fails closed: nothing reaches another
address.

## Key rotation and retirement

To rotate, repeat step 2 with the new key and merge. The proxy reads the key on
every request, so the new key is used once the kubelet updates the mounted
file (about a minute), without a restart. Then revoke the old key in the
Console.

To retire, remove `./claude-proxy` from `kubernetes/apps/personal-apps/kustomization.yaml`
and this folder in one change, and revoke the key. The namespace has
`prune: disabled`, so delete it by hand afterwards.
