# Personal apps

Apps the owner writes and ships from their own repositories, one namespace per
app. There are two ways to run one:

- **Platform apps** (the default): the code lives in the private `apps`
  monorepo, CI publishes `ghcr.io/<owner>/apps/<app>`, and this repo generates
  the manifests from one shared template and a few settings. `hello` is the
  throwaway proof app. Everything below up to "Bundle apps" is about them.
- **Bundle apps**: the older way, where an app's CI also publishes a private OCI
  bundle with its manifests and a scoped service account applies it. No app
  runs this way now. Quilt Planner did until it moved onto the platform; see
  "Bundle apps" at the end.
- **Homepage** (`homepage/`, `homepage-family/`): the two Homepage dashboards,
  from a public chart rather than the owner's code, so neither of the above. They
  share the Namespace `homepage` (folder `homepage/`). Their Flux Kustomizations
  `homepage` and `homepage-family` stay in the Flux namespace `home` (explicit
  `metadata.namespace`, listed straight from `personal-apps/kustomization.yaml`
  so no `namespace:` field moves them) and read `cluster-secrets` from the copy
  that `home/` keeps; the workloads run in `homepage`, which holds no
  cluster-wide Secret. `home` itself is reserved for Home Assistant and its
  neighbours.
- **Deal Watch worker** (`deal-watch/integrations/`): the integration worker
  for the Deal Watch platform app. Its code is `integrations/deal-watch/` in
  this repo. It holds credentials (the Discord webhook, the watch policy and a
  GHCR pull credential, all SOPS-encrypted), so it runs outside the platform in
  its own Namespace `deal-watch-integrations`. Its Flux Kustomization
  `deal-watch-integrations` stays in `flux-system` and is listed on its own in
  `personal-apps/kustomization.yaml`, so the dashboard's `namespace: deal-watch`
  does not apply to it.
- **Claude API proxy** (`claude-proxy/`): holds the Anthropic API key and caps
  daily spend for platform apps that run a Claude agent (`egress:
  claude-proxy`). Its code is `integrations/claude-proxy/` in this repo. It
  holds credentials (the API key and a GHCR pull credential, both
  SOPS-encrypted), so it runs outside the platform in its own Namespace
  `claude-proxy`. Its Flux Kustomization `claude-proxy` stays in `flux-system`
  and is listed in `personal-apps/kustomization.yaml`.
- **share-admin** (`share-admin/`): edits the guest list of the reports share
  and holds the Cloudflare API token for it. Its code is
  `integrations/reports-share-admin/` in this repo. It runs outside the platform
  in its own Namespace `share-admin`; its Flux Kustomization `share-admin` stays
  in `flux-system`. The reports app reaches it through the `share-admin` part.
  See "share-admin" below.

## Platform apps

### How it fits together

- `kubernetes/apps/flux-system/app-platform/apps/<app>.yaml`: the **entry**, a
  `ResourceSetInputProvider` (RSIP) that watches the `main` tag of the app's
  image every 2 minutes and carries the app's settings.
- The `ResourceSet` `apps` (`app-platform/app/resourceset.yaml`) renders one Flux
  Kustomization `app-<name>` in `flux-system` per entry. It applies
  `kubernetes/components/app-platform/base` (PVC, Service, Deployment) plus the
  parts the entry lists, with the image digest and the settings in
  `postBuild.substitute`. It has `wait: true`, `deletionPolicy: Orphan` and SOPS
  decryption.
- The `ResourceSet` `apps-pull` (`resourceset-pull.yaml`) copies the registry
  Secret `flux-system/ghcr-apps-read` into each app's namespace as `apps-ghcr`.
  It is a separate ResourceSet so that its failures never block `apps`.
  Its `spec.inputs` also lists the namespaces `claude-proxy`,
  `deal-watch-integrations`, `deal-watch-ebay` and `share-admin`, which are not platform apps,
  so they get an `apps-ghcr` copy too. Those namespaces must exist (their own
  Kustomizations create them), or no copy is applied.
- `kubernetes/apps/personal-apps/<namespace>/`: the app's Namespace, Git-defined,
  Pod Security `restricted`, prune-disabled. Only the Namespace lives here,
  plus `mapkit.sops.yaml` for an entry with the `mapkit` part (see "Apple Maps
  (the mapkit part)").
- Failures go to Discord through the Flux `Provider` and `Alert` in
  `app-platform/app`. The Alert covers Flux events only. The PrometheusRule
  `app-platform` (`observability/kube-prometheus-stack/app`) alerts when an
  `app-*` Kustomization, an entry or either ResourceSet is not Ready for 10
  minutes, or when an app's Deployment has unavailable replicas. flux-operator
  exports ResourceSets and entries under their own metric names
  (`flux_resourceset_info`, `flux_resourcesetinputprovider_info`), not
  `flux_resource_info`; `promtool test rules` checks the expressions against
  those series.

**Adding an app is one entry file plus one tiny Namespace folder in the same
PR. Updating an app is a merge in the `apps` repo. Changing its settings,
exposure or backups is a PR here.** Merging a PR that adds an entry deploys the
app, so it needs the owner's approval.

### Add an app

`<name>` matches `^[a-z][a-z0-9-]*$`. It is the Deployment, Service, image name,
default namespace and default host.

1. Create `app-platform/apps/<name>.yaml` (the file name is the app name; the
   object is named `app-<name>`) and add `- ./<name>.yaml` to
   `app-platform/apps/kustomization.yaml`:

    ```yaml
    apiVersion: fluxcd.controlplane.io/v1
    kind: ResourceSetInputProvider
    metadata:
        name: app-<name>
        namespace: flux-system
        labels:
            platform/apps: "true"
        annotations:
            fluxcd.controlplane.io/reconcileEvery: 2m
    spec:
        type: OCIArtifactTag
        url: oci://ghcr.io/<owner>/apps/<name>
        secretRef:
            name: ghcr-apps-read
        filter:
            includeTag: "^main$"
            limit: 1
        defaultValues:
            name: <name>
            parts: [pullsecret, internal-route, backup, backup-sqlite]
            vars:
                SQLITE_DBS: <name>.db
                VOLSYNC_SCHEDULE: "<UTC cron>"
                SQLITE_SCHEDULE: "<UTC cron, ten minutes before the backup>"
    ```

2. Create `personal-apps/<name>/kustomization.yaml` and add `- ./<name>` to
   `personal-apps/kustomization.yaml`. The namespace is the app name:

    ```yaml
    apiVersion: kustomize.config.k8s.io/v1beta1
    kind: Kustomization
    namespace: <name>
    components:
        - ../../../components/personal-namespace
    ```

3. Pick the next free backup slot (the schedule table in
   `kubernetes/components/volsync/README.md`) and add the app to it. Every entry
   with `backup` or `backup-sqlite` names its schedules explicitly, and no two
   entries share one.
4. Add the namespace to the `namespace=~"..."` list of the alert
   `AppPlatformDeploymentUnavailable` in
   `observability/kube-prometheus-stack/app/prometheusrule-app-platform.yaml`
   (kube-state-metrics exports no namespace labels; the validator checks that
   the list is complete). Do not deploy an app without alerts.
5. Add a link to the app on `network/fallback-pages/app/internal-not-found.html`
   (and `family-not-found.html` for a family app), as the family-apps README
   requires. A throwaway such as `hello` is not linked.
6. Run `scripts/validate-kubernetes.sh` (it runs `scripts/validate-apps.sh`; run
   that alone while you iterate). In the PR description say what merging does
   live (pods, route, backup) and that it needs the owner's approval. An entry
   without an image yet is harmless: the RSIP exports nothing, so nothing
   renders.

The folders `app-platform/`, `app-platform/app/` and `app-platform/apps/` are
applied by a cluster-admin Kustomization, so their shape is fixed and checked:
`apps/` holds `kustomization.yaml` and one top-level `<name>.yaml` per entry,
each a single `ResourceSetInputProvider`, and its `kustomization.yaml` lists
exactly those files (no subfolder, no other resource, no generator, patch or
component); `app/` holds only the known objects (the two ResourceSets, the
Provider, the Alert and the two Secrets). Anything else fails the validator.

The Namespace folder must be in the same PR. A ResourceSet applies none of its
objects when one fails the API server's dry run, so one Secret copy whose
namespace does not exist yet would delay every app's copy in `apps-pull`, and
one Kustomization the API server rejects would block every app in `apps`.

### Settings

Everything under `defaultValues`. The validator rejects unknown keys, here and
in the entry's `spec` (only `type`, `url`, `secretRef`, `filter` and
`defaultValues`). Everything under `vars` becomes an uppercase substitution
variable.

| Key                                             | Default                                | Meaning                                                                                                                                                                                                                               |
| ----------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                          | required                               | Deployment, Service, image name, default namespace and host                                                                                                                                                                           |
| `namespace`                                     | `name`                                 | Must equal `name`: an app lives in the namespace of its own name (its network policy is namespace-wide and would default-deny another app's pods). The folder `personal-apps/<name>/` must exist                                           |
| `parts`                                         | `[pullsecret, internal-route, backup]` | Pieces to add (below). `namespace` is not a part                                                                                                                                                                                      |
| `netpol`                                        | `true`                                 | The default-deny network policy. `false` needs a `netpolReason`                                                                                                                                                                       |
| `netpolReason`                                  | none                                   | Free text, required with `netpol: false`. The validator prints every exemption with its reason                                                                                                                                        |
| `egress`                                        | `none`                                 | `none` (DNS and the own namespace only), `internet` (public addresses on all ports, never private ranges) or `claude-proxy` (the claude-proxy pods on 3000/TCP only)                                                                                                                           |
| `pin`                                           | none                                   | A `sha256:` digest that wins over the registry's: the rollback and migration lever                                                                                                                                                    |
| `env`                                           | none                                   | Plain extra environment. Keys uppercase, not `N`, `Y`, `ON`, `OFF`, and not credential-like (`TOKEN`, `SECRET`, `PASS`, `PWD`, `KEY`, `AUTH`, `PRIVATE`, `CERT`, ...). A literal `$` is written `$$` (`$${X}` gives a literal `${X}`) |
| `path`                                          | the base                               | The escape hatch (below). No trailing slash                                                                                                                                                                                           |
| `vars.CLAIM`                                    | `<name>-data`                          | PVC name                                                                                                                                                                                                                              |
| `vars.STORAGE`, `vars.STORAGE_CLASS`            | `1Gi`, `local-retain`                  | PVC size and class. The class must have reclaim policy `Retain`                                                                                                                                                                       |
| `vars.HEALTH_PATH`                              | `/healthz`                             | Probe path                                                                                                                                                                                                                            |
| `vars.APP_UID`, `vars.APP_GID`                  | `1000`, `1000`                         | Pod, VolSync mover and SQLite export identity. `0` is rejected                                                                                                                                                                        |
| `vars.DATA_PATH`                                | `/data`                                | Mount path and `DATA_DIR`                                                                                                                                                                                                             |
| `vars.CPU`, `vars.MEMORY`, `vars.MEMORY_LIMIT`  | `50m`, `128Mi`, `512Mi`                | Requests and the memory limit                                                                                                                                                                                                         |
| `vars.IMAGE`                                    | `ghcr.io/<owner>/apps/<name>`          | Override only while adopting a differently named image                                                                                                                                                                                |
| `vars.PULL_SECRET`                              | `apps-ghcr`                            | The Secret name the Deployment references. The copied Secret is always `apps-ghcr`                                                                                                                                                    |
| `vars.HOST`                                     | `name`                                 | `<HOST>.${SECRET_DOMAIN_LOCAL}`                                                                                                                                                                                                       |
| `vars.FAMILY_HOST`                              | none                                   | With `family-route`: `<FAMILY_HOST>.${SECRET_FAMILY_DOMAIN}`                                                                                                                                                                          |
| `vars.TITLE`, `vars.DESCRIPTION`, `vars.ICON`  | `name`, `Platform app`, `mdi-application` | The LAN dashboard tile that `internal-route` registers (Homepage discovers the route). Title and description: start with a letter, only letters, digits, spaces and `.,()'&/+!?-`, at most 80, never a YAML boolean or null word (`yes`, `no`, `on`, `off`, `true`, ...). Icon: `mdi-<name>`, `si-<name>`, `sh-<name>` or `<name>.png`/`.svg`/`.webp` |
| `vars.SQLITE_DBS`                               | none                                   | Space-separated database paths for `backup-sqlite`                                                                                                                                                                                    |
| `vars.VOLSYNC_SCHEDULE`, `vars.SQLITE_SCHEDULE` | none                                   | Explicit UTC cron strings, required with `backup` / `backup-sqlite`                                                                                                                                                                   |
| `vars.JOB_SCHEDULE`                             | none                                   | Required with `job`: an explicit UTC cron string of five fields, each in range (minute 0-59, hour 0-23, day 1-31, month 1-12 or `JAN`-`DEC`, weekday 0-6 or `SUN`-`SAT`), that starts with a digit (`0-59/15`, not `*/15`: Flux drops the quotes, and YAML reads a leading `*` as an alias) |
| `vars.JOB_COMMAND`                              | none                                   | Required with `job`: the command, run as `/bin/sh -c "exec <JOB_COMMAND>"`. Only letters, digits, spaces and `./_=:-`, at most 200, no colon before a space or at the end                                                              |
| `vars.JOB_READ_PATH`, `vars.JOB_WORK_PATH`      | none                                   | Required with `job`: folders relative to the volume root, mounted read only at `/job/read` and read and write at `/job/work`. Start with a letter, no `..` or hidden segments, never a YAML boolean or null word (`yes`, `no`, `on`, `off`, `true`, `null`, ...), and neither equals or contains the other |
| `vars.JOB_DEADLINE`, `vars.JOB_MEMORY_LIMIT`    | `3600`, `512Mi`                        | With `job`: the run's time limit in seconds (1 to 86400) and its memory limit (at least the container's 64Mi request)                                                                                                               |
| `vars.JOB_EGRESS_CIDR`                          | none                                   | Required with `job-egress`: one public IPv4 CIDR, `/16` to `/32`, that the job pods reach on 443/TCP                                                                                                                                  |

Parts (`kubernetes/components/app-platform/`): `pullsecret` (a name only: the
Secret is rendered by `apps-pull`), `internal-route` (`<HOST>.${SECRET_DOMAIN_LOCAL}`
on `envoy-internal`, no retries for writes, and the tile on the LAN dashboard
`home.${SECRET_DOMAIN_LOCAL}`, discovered from the route's `gethomepage.dev/*`
annotations), `family-route` (only on request;
see `network/family-apps/README.md`; needs `vars.FAMILY_HOST`),
`family-route-legacy` (the transitional `family.${SECRET_DOMAIN_LOCAL}` name;
list it after `family-route`), `backup` (the `volsync` component),
`backup-sqlite` (the `sqlite-export` component, with no service-account token),
`job` (a CronJob that runs a command from the app's image; see "Scheduled
jobs"), `job-egress` (443/TCP to one public CIDR for the job pods only;
needs `job`) and `mapkit` (a MapKit JS token from the Secret `<name>-mapkit`,
for an app that draws Apple maps; see "Apple Maps (the mapkit part)") and
`share` (a read-only guest port reached through a Cloudflare Tunnel behind
Cloudflare Access; needs `vars.SHARE_HOST` and `vars.GUEST_COLLECTIONS` and the
folder `personal-apps/<name>-share/`; see "Guest sharing (the share part)") and
`share-admin` (the `SHARE_ADMIN_URL` variable and a second policy that lets the
app pod, and no other pod, reach the share-admin service on 8080/TCP; the
reports entry only; see "share-admin").
The `netpol` and `egress` keys add the `netpol` component and then
`netpol-egress-internet` or `netpol-egress-claude-proxy` after the parts, so an
explicit `parts: []` still gets the policy.

### The container contract

The generated Deployment assumes it; the `apps` template enforces it.

- Listens on port 3000 and reads `$PORT`; serves `GET <HEALTH_PATH>` with 200
  when ready. The port is fixed on purpose: Flux substitution turns a numeric
  value into an integer, which the API rejects for an environment value.
- **Keeps idle HTTP connections open for longer than 60 s.** The gateway closes
  its idle connections to the app at 60 s (`connectionIdleTimeout` on the
  `writes` policy) and never retries a write, so the app must close later, which makes
  a failed write very unlikely. Bun's default is 10 s; the template sets `idleTimeout: 75`.
- Writes only under `$DATA_DIR` (the PVC) and `/tmp` (a 128 Mi `emptyDir`). The
  root filesystem is read-only. Runs as a non-root uid, all capabilities dropped,
  `linux/amd64`, one replica with strategy `Recreate` (SQLite is single-writer).
- **Receives no Secrets**: no `valueFrom`, `secretKeyRef`, `envFrom` of a Secret
  or Secret volume, and `automountServiceAccountToken` is false on every pod. The
  only Secret a pod references is the `apps-ghcr` image pull Secret. The one
  exception is the `mapkit` part: the app container of the app's Deployment
  reads the one key `MAPKIT_TOKEN` of `<name>-mapkit`, and nothing else does.
- **Takes its own pre-migration copy** into `$DATA_DIR/backups/`. Pinning an old
  digest does not roll data back.
- Reaches the network only as the policy allows (below).

### Network policy

Every app namespace is default-deny, for **all** its pods: the app, export jobs,
VolSync movers and any pod of a custom folder (the policy selects the whole
namespace with an empty `endpointSelector`). Ingress comes only from the pods of
the namespace, the two Envoy gateways on port 3000 and the kubelet (probes).
Egress goes only to cluster DNS and the namespace's own pods. `egress: internet`
adds public addresses on every port, never the private ranges (LAN, VLANs,
Tailscale, cluster). `egress: claude-proxy` adds only the claude-proxy pods on
3000/TCP, for an app that runs a Claude agent: the proxy, outside the platform,
holds the Anthropic API key and caps daily spend (`kubernetes/apps/personal-apps/claude-proxy/`,
added by its own change),
and admits only the app pods its own policy lists (by namespace and `app.kubernetes.io/name`). Nothing reaches the Kubernetes API, the NAS or other
namespaces. DNS remains a tunnelling channel for a compromised app. Prometheus
cannot scrape an app; that would be a reviewed addition. `job-egress` is the
one rule for some pods only: a second policy that lets the job pods, and no
other pod, reach one public CIDR on 443, and denies them the app's namespace
and claude-proxy (see "Scheduled jobs"). `share` and `share-admin` are per-pod
rules of the same kind: a second policy that selects the app pod only. `share`
opens 3001 to the cloudflared pods of `<name>-share` and denies 3001 to the node
and to every other pod of the app's namespace (see "Guest sharing"); `share-admin` lets the app
pod send to the pods in the namespace `share-admin` on 8080/TCP, so the app does
reach another namespace there, and nothing else in its namespace gets that.

Hubble is off in this cluster. To see drops, run `cilium-dbg monitor --type drop`
in the node's Cilium agent pod. Do not widen a policy to fix a drop without a
reviewed reason: use `egress: internet` for public services, `job-egress` for a
scheduled job that needs one public service, and redesign for anything private.

### Scheduled jobs

The `job` part adds the CronJob `<name>-job`. On `vars.JOB_SCHEDULE` (UTC) it
runs `vars.JOB_COMMAND` from the app's own image, at the same digest as the
Deployment, as `/bin/sh -c "exec <JOB_COMMAND>"` in the image's working
directory, so the image needs `/bin/sh`. One run at a time, no retry, at most
`JOB_DEADLINE` seconds (default 3600) and `JOB_MEMORY_LIMIT` of memory (default
512Mi). A failed run waits for the next slot.

- **Mounts:** the app's data volume twice, `JOB_READ_PATH` read only at
  `/job/read` and `JOB_WORK_PATH` read and write at `/job/work` (both relative
  to the volume root), plus an `emptyDir` at `/tmp`. The job finds the two
  folders in `JOB_READ_DIR` and `JOB_WORK_DIR`, and the app picks up what the
  job writes. The volume is node-local, so the job runs on the app's node,
  beside the app. A folder that does not exist is created by the kubelet,
  owned by root:root with the mode of the volume root (0777 on
  `local-retain`). So a mistyped path mounts an empty folder and gives no
  error: check both paths against the app. The reports app creates `feeds/`
  when it starts.
- **Pod:** the same rules as the app's pod: Pod Security `restricted`, the
  app's uid and gid, a read-only root filesystem, no service-account token and
  no Secret except the pull Secret. The entry's `env` does not reach it.
- **Label:** the job pods carry `app.kubernetes.io/name: <name>-job`, which the
  egress policy selects. The validator fails when any other pod of the app
  carries it.
- **Network:** without `job-egress`, the job pods have the same network as the
  app's pods (the namespace policy and its `egress` mode). `job-egress` adds a
  second CiliumNetworkPolicy, `<name>-job`, that selects only the job pods and
  allows 443/TCP to one range, `vars.JOB_EGRESS_CIDR`, with no ingress rule.
  Cilium adds up the policies that select a pod: the namespace policy keeps
  default deny and DNS for every pod, and this one opens only the job pods to
  that range. The app's other pods get nothing from it: with `egress: none` or
  `egress: claude-proxy` they stay without internet.
- **Not the app or the proxy:** the job pods are the only pods with internet
  access, so the same policy denies them the app's own namespace (an app's
  write routes may need no login, as the reports app's do) and the
  `claude-proxy` namespace (its daily spend), with `egressDeny` rules. A
  Cilium deny rule wins over every allow rule for the pods it selects, in any
  policy ([Deny Policies](https://docs.cilium.io/en/v1.20/security/policy/deny/)),
  so the namespace policy's own-namespace and claude-proxy rules no longer
  apply to the job pods. DNS still works. The proxy's own policy also admits
  only the app pods of the apps it lists (reports, job-tracker and fantasy), not their
  jobs.
- **Why a fixed CIDR:** the cluster uses no `toFQDNs` rules, so the policy
  names an address, not a host. If the host moves to another address, the job
  fails closed: its connections time out until the entry has the new CIDR. A
  CDN address is shared, so the rule allows every site the CDN serves there,
  not only the one the job needs. The validator accepts only a public IPv4
  range from `/16` to `/32`: never one that overlaps the private ranges
  `egress: internet` excepts, `0.0.0.0/8` or `127.0.0.0/8`.

### Escape hatch

1. A new `vars` key or a new `components/app-platform/<part>` (a PR here).
2. `env`: plain extra environment through a generated patch.
3. `path: ./kubernetes/apps/personal-apps/<name>/app`: the same Kustomization applies
   the app's own folder instead of the base. Plain manifests only: Deployment,
   StatefulSet, Job, CronJob, Service, ConfigMap, PersistentVolumeClaim. The
   validator rejects `HelmRelease`, any network policy, `Role`, `RoleBinding`,
   `ClusterRole*`, `ServiceAccount`, `ExternalSecret`, `SealedSecret`, `Secret`
   and `secretGenerator`. Its pods get the same rules as the base: Pod Security
   `restricted` fields, a read-only root filesystem, no `hostPort`, no host
   namespaces, no `privileged`, no `runAsUser: 0`, no `serviceAccountName`, and
   only `persistentVolumeClaim`, `emptyDir` and `configMap` volumes (no `nfs`,
   `hostPath` or Secret); Services are plain ClusterIP. The folder needs a
   `kustomization.yaml` and is never the Namespace folder itself.
4. Out of the platform: no entry, a normal app under `kubernetes/apps/<ns>/`.

Postgres or any service that needs a credential is deferred; apps hold none,
except the MapKit JS token of the `mapkit` part.

### Apple Maps (the mapkit part)

The reports app draws Apple maps with MapKit JS. The browser loads Apple's
script and map tiles, and asks the app for a MapKit JS token. The token is an
ES256 JWT that the owner signs on their own computer, once a year, with the
MapKit private key (a `.p8` file from the Apple Developer account). The
private key never enters the cluster or Git. Create a key for this use only,
with MapKit JS as its only enabled service.

The token is the one credential a platform app may hold, and it is a narrow
one:

- Every reader's browser gets it, so it is not secret from readers.
- Browsers use it only on the host names in its `origin` claim, and only for
  MapKit JS (`scope: mapkit_js`). A script can send any `Origin` header, so a
  copied token works from a script until it expires or the owner revokes the
  key that signed it. Its cost is the account's MapKit quota; it signs nothing.
- It expires 364 days after it is signed.
- It is kept in a SOPS Secret because its `origin` claim names the site's
  hosts, and the zone never goes into Git.

The `mapkit` part adds two environment variables to the container `app` of
the app's Deployment:

| Variable | From |
| --- | --- |
| `MAPKIT_TOKEN` | The Secret `<name>-mapkit`, `secretKeyRef` with `optional: true` |
| `MAPKIT_ORIGINS` | `https://<HOST>.${SECRET_DOMAIN_LOCAL},https://<FAMILY_HOST>.${SECRET_FAMILY_DOMAIN},https://<SHARE_HOST>.<zone>`, the same names as the routes and the guest host of the `share` part |

With `optional: true`, the app starts without the Secret, and shows a note in
place of each map. Without `vars.FAMILY_HOST` the second origin has an empty
first label, and the app ignores it; the same holds for the third origin
without `vars.SHARE_HOST`. The part also sets
`secret.reloader.stakater.com/reload: <name>-mapkit` on the Deployment, so
Reloader restarts the app when the token changes.

The Secret is a SOPS file in the app's Namespace folder,
`kubernetes/apps/personal-apps/<name>/mapkit.sops.yaml`, listed in that
folder's `kustomization.yaml`. `cluster-apps` applies and decrypts it. The
validator requires the file with the part and refuses it without the part. It
reads the metadata and the shape only, never a value:

- One `Opaque` Secret `<name>-mapkit` with exactly the key `MAPKIT_TOKEN`,
  encrypted under `stringData`.
- `sops` metadata that matches the `.sops.yaml` rule for `kubernetes/`: one
  age recipient (the repo's), the same `encrypted_regex` and
  `mac_only_encrypted`, and an encrypted MAC. `cluster-apps` must be able to
  decrypt the file: if it cannot, the whole `cluster-apps` build stops until
  Git is fixed.
- With the part, the folder holds only `kustomization.yaml` and
  `mapkit.sops.yaml`, and its `kustomization.yaml` lists only
  `./mapkit.sops.yaml`. `cluster-apps` applies the folder without a pod check,
  so nothing else may sit beside the Secret.

The validator also refuses any other Secret reference, and this reference
anywhere except the app container of the app's Deployment. The job's CronJob
never gets it. Only a `kubernetes.io/dockerconfigjson` Secret can be
`vars.PULL_SECRET`.

#### Sign the token, the first time and every year

Run this on the owner's computer, from the root of a checkout you trust, in
bash or zsh (type `zsh` first; a fish shell cannot run it), with `op` signed in, the repo's age key available to `sops` (for
the two zones), and `jq`, `yq`, `sops` and `node` on the `PATH`. Replace the three
references with the 1Password item that holds the key: the `.p8` file attached
to the item (or a field with its PEM text), the Key ID and the Team ID.

```sh
( set -o pipefail
  f=kubernetes/apps/personal-apps/reports/mapkit.sops.yaml
  cs=kubernetes/components/sops/cluster-secrets.sops.yaml
  lan="$(sops decrypt --extract '["stringData"]["SECRET_DOMAIN_LOCAL"]' "$cs")" \
    && fam="$(sops decrypt --extract '["stringData"]["SECRET_FAMILY_DOMAIN"]' "$cs")" \
    && dom="$(sops decrypt --extract '["stringData"]["SECRET_DOMAIN"]' "$cs")" || exit 1
  jq -n --rawfile key <(op read 'op://<vault>/<item>/<key file>.p8') \
        --rawfile kid <(op read --no-newline 'op://<vault>/<item>/<Key ID field>') \
        --rawfile team <(op read --no-newline 'op://<vault>/<item>/<Team ID field>') \
        --rawfile origin <(printf '%s' "reports.$lan,reports.$fam,share.$dom") \
        '{key: $key, kid: ($kid | gsub("\\s"; "")), team: ($team | gsub("\\s"; "")), origin: $origin, days: 364}' \
    | node -e '
const c = require("node:crypto"), fail = (m) => { process.stderr.write("failed: " + m + "\n"); process.exit(1); };
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const v = JSON.parse(s), id = /^[A-Z0-9]{10}$/;
  if (!id.test(v.kid) || !id.test(v.team)) fail("the Key ID and the Team ID must be 10 capital letters or digits");
  let key; try { key = c.createPrivateKey(v.key); } catch { fail("the private key is not a PEM key"); }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails.namedCurve !== "prime256v1") fail("the private key is not ECDSA P-256");
  const iat = Math.floor(Date.now() / 1000), exp = iat + v.days * 86400, b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = b({ alg: "ES256", kid: v.kid, typ: "JWT" }) + "." + b({ iss: v.team, iat, exp, scope: "mapkit_js", origin: v.origin });
  const sig = c.sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" });
  if (!c.verify("sha256", Buffer.from(data), { key: c.createPublicKey(key), dsaEncoding: "ieee-p1363" }, sig)) fail("the signature did not check out");
  process.stderr.write("the token expires on " + new Date(exp * 1000).toISOString().slice(0, 10) + "\n");
  process.stdout.write(JSON.stringify({ token: data + "." + sig.toString("base64url") }));
});' \
    | jq '{apiVersion: "v1", kind: "Secret", metadata: {name: "reports-mapkit", namespace: "reports"}, type: "Opaque", stringData: {MAPKIT_TOKEN: .token}}' \
    | sops encrypt --filename-override "$f" --input-type json --output-type yaml /dev/stdin > "$f.tmp" \
    && [ "$(yq '[.stringData[] | test("^ENC\\[")] | all' "$f.tmp")" = true ] \
    && mv "$f.tmp" "$f" || { rm -f "$f.tmp"; echo "failed: $f was not written" >&2; false; } )
```

The key and the IDs go from `op` to `jq` to `node` through pipes (`/dev/fd`),
never through a command line, a variable in the environment or a file. The
token goes from `node` to `sops` through pipes too. Only the encrypted output
is written, to `<file>.tmp` first. A failure leaves no new file and keeps an
existing one. Nothing prints the key, the IDs or the token. The token's
`origin` claim names the three hosts (LAN, family and the guest host),
comma-separated, which Apple documents for
`origin`; Apple documents no longest lifetime, so the token lasts 364 days.

Check the shape, without decrypting (the key name stays readable):

```sh
yq '.stringData | keys' kubernetes/apps/personal-apps/reports/mapkit.sops.yaml
# - MAPKIT_TOKEN
```

Commit and merge the file. Reloader restarts the app when Flux applies the new
Secret. The app's log then says `maps on for https://reports.local.<zone>,
https://reports.family.<zone>; the token expires on <date>`. If it says `maps
off`, the pod started before the Secret arrived: restart the Deployment once
(`kubectl -n reports rollout restart deployment/reports`).

Renew once a year, with the same command. Set a calendar reminder a month
before the expiry date that the command prints. In the token's last 30 days the
app's log warns once a day, and every map shows a note: "The site's Apple Maps
token expires on <date>." After it expires, every map shows "Map unavailable:
the site's Apple Maps token expired on <date>" with its list of places, until
the new token is merged. To replace a lost or leaked key or token, make a new
key in the Apple Developer account, sign a new token with it, merge, and then
revoke the old key (that ends every token it signed).

### Guest sharing (the share part)

The `share` part gives one outside person, such as a realtor, a read-only view
of one collection of an app (reports: `fay-ave`) at `share.<zone>`. They need no
Tailscale. Nothing else is exposed.

What it exposes: the app's guest port, 3001, which serves only the collections
in `vars.GUEST_COLLECTIONS`, read-only, and only for the host
`<SHARE_HOST>.<zone>`. The main port, 3000, stays full access and is
reachable only from the two gateways (LAN and family).

The path: browser, Cloudflare Access (email one-time PIN), Cloudflare edge, the
tunnel `reports-share`, cloudflared in the Namespace `<name>-share`, the Service
`<name>-share` (3001 only), the app pod.

The two locks:

1. **Who may ask.** Cloudflare Access at the edge allows only the listed emails,
   and cloudflared checks the Access token itself
   (`originRequest.access.required` with the application's aud tag in
   `reports-share/app/resources/cloudflared.yaml`), so a request without a valid
   token is refused even if it reached the tunnel another way.
2. **What it can reach.** Two Cilium policies. cloudflared may reach only the
   reports pod on 3001/TCP, cluster DNS and Cloudflare (7844 for the tunnel, 443
   for the Access signing keys, both to Cloudflare's published ranges); it can
   never reach port 3000 or another namespace. The `share` part's policy
   `<name>-share` lets only the cloudflared pods in `<name>-share` reach the app
   on 3001, and the namespace policy still admits 3000 only from the gateways
   (and the node, for probes). The validator compares both with the design.

   The same policy also holds an `ingressDeny` for 3001, and it matters: the app
   trusts the Access token as cloudflared passes it (claims mode, below), so
   whoever can open a connection to 3001 can claim to be any guest. Two built-in
   allow rules would let others in: the namespace policy's first rule admits
   every pod of the namespace on every port, and Cilium's allow-localhost admits
   the node's host processes on every port. A deny wins over every allow, so the
   policy denies 3001 from the host entity (kubelet, Alloy, node-exporter, the
   Cilium agent, any process on the node) and from every pod of the namespace
   whose `app.kubernetes.io/name` is not the app's own. That is the weekly job
   pod (`<name>-job`), the backup pods and, because `NotIn` also matches a pod
   that has no such label, the VolSync mover and sqlite-export pods. Only the
   app pod and cloudflared are left. The kubelet's probes go to 3000, which the
   deny does not touch. `GUEST_TRUSTED_PEERS` (the app's own address check) is
   left unset: it would need cloudflared's pod range, which moves with the
   cluster, and the policy is the lock.

What is where:

| File | What |
| --- | --- |
| `components/app-platform/share/` | The part: `GUEST_PORT`, `GUEST_COLLECTIONS`, `GUEST_HOSTS`, `GUEST_ACCESS_MODE=claims`, `GUEST_ACCESS_AUD`, `GUEST_ACCESS_TEAM`, `GUEST_AGENT=on`, `SHARE_ADMIN_HOSTS` and the `guest` container port, the Service `<name>-share`, the policy `<name>-share` (allow from cloudflared, deny for the node and the other pods). `mapkit` adds the guest host to `MAPKIT_ORIGINS` |
| `personal-apps/reports-share/` | cloudflared: Namespace (restricted), Flux Kustomization, Deployment (non-root, read-only root, no capabilities, `/ready` probes), its policy, the routing in `app/resources/cloudflared.yaml` and the credentials Secret |
| `components/app-platform/share-admin/` | The `share-admin` part: `SHARE_ADMIN_URL` and the policy `<name>-share-admin` (see "share-admin") |
| `terraform/dns/main.tf`, `terraform/dns/access.tf` | The proxied CNAME `share.<zone>` to `<tunnel id>.cfargotunnel.com` (variable `reports_share_tunnel_id`), and the Access login: the one-time PIN login method, the policy for the guest emails (seeded from `reports_share_guest_emails`, then kept in the dashboard) and the Access application |

The tunnel is locally managed: the routing is in Git, the credentials are a file
(`credentials.json`) in the SOPS Secret `reports-share-tunnel`. Three values stay
out of this public repo, as `cluster-secrets` keys that Flux substitutes into the
routing: `SECRET_SHARE_TUNNEL_ID`, `SECRET_SHARE_ACCESS_TEAM` and
`SECRET_SHARE_ACCESS_AUD`. Set them before the cloudflared Kustomization
reconciles, or it renders an empty tunnel id and cloudflared stays down.

#### Set it up (the owner)

Nobody but the owner handles the credentials; do not paste them into chat.

1. Install cloudflared and log in (the browser asks for the zone):
   `brew install cloudflared`, then `cloudflared tunnel login`.
2. Create the tunnel: `cloudflared tunnel create reports-share`. It prints the
   tunnel id and writes `~/.cloudflared/<id>.json`.
3. Save that file in 1Password as a document or a field named `credentials.json`,
   and the tunnel id beside it. Then delete the local `<id>.json`. The
   `cert.pem` from the login can create tunnels in the zone: keep it in
   1Password too, or delete it.
4. Zero Trust team, once. If the account has no Zero Trust team yet, open
   Zero Trust in the Cloudflare dashboard, pick a team name and choose the Free
   plan. Note the team name: it is the part of the team domain before
   `.cloudflareaccess.com` (Settings, General).
5. Add two permissions to the Cloudflare token (1Password item "Cloudflare User
   API Token"), at the account level: **Access: Apps and Policies** and **Access:
   Identity Providers**, each with Edit (the API docs call it Write), and
   Account Resources must include your account. The token is shared with
   `terraform/cloudflare-security`; that is accepted on purpose.
6. Merge the Terraform change (it holds `terraform/dns/access.tf`), then update
   the main checkout with `but pull`. Merging it changes nothing in the cluster
   or in Cloudflare.
7. In the main checkout, put these lines in the git-ignored
   `terraform/dns/tunnel.auto.tfvars`. The file must ALSO hold the Flux webhook
   line, or the plan wants to destroy the flux-webhook record. The guest
   address belongs only in this file, never in Git, and a validation error
   prints the line, so do not paste it anywhere:

   ```hcl
   flux_webhook_tunnel_id     = "<flux-webhook tunnel id>"
   reports_share_tunnel_id    = "<tunnel id from step 2>"
   reports_share_guest_emails = ["guest@example.com"]
   ```

8. Run `just dns plan`. It must show exactly 4 to add, 0 to change and 0 to
   destroy: the DNS record `reports_share`, the login method
   `reports_share_otp`, the policy `reports_share_guests` and the application
   `reports_share`. `just dns plan` ends with exit code 2 when there are
   changes; that is normal. If the plan shows anything else, above all a
   destroy, stop and do not apply.
9. Run `just dns apply`. If creating the login method fails, either with an
   auth error (the token permission is not accepted for it) or because the
   account already has One-time PIN (an account may have only one), use the
   fallback: in the dashboard turn on One-time PIN once (Zero Trust,
   Integrations, Identity providers, Add new, One-time PIN), copy its ID, add
   `reports_share_otp_idp_id = "<id>"` to the tfvars file and plan again. The
   plan then shows 3 to add, and Terraform creates no login method. If an apply
   fails part way, import what it created (the import commands are in the
   comment at the top of `access.tf`) and plan again: the plan then shows only
   what was not created.
10. Print the application's aud tag. From the main checkout:
    `terraform -chdir=terraform/dns output -raw reports_share_access_aud` (it
    needs no `sops exec-env`). The team name is from step 4.
11. Steps 11 to 14 run on the branch of this PR (the share part). From the repo
    root, type `zsh` first (a fish shell cannot run the loop), then set the
    three `cluster-secrets` keys (the loop waits for you to type each value;
    nothing is printed, and it stops at an empty value):

    ```sh
    cs=kubernetes/components/sops/cluster-secrets.sops.yaml
    for k in SECRET_SHARE_TUNNEL_ID SECRET_SHARE_ACCESS_TEAM SECRET_SHARE_ACCESS_AUD; do
      printf '%s: ' "$k" >&2; IFS= read -r -s v; echo >&2
      [ -n "$v" ] || { echo "empty $k: stopped" >&2; break; }
      printf '%s' "$v" | jq -Rs . | sops set --value-stdin "$cs" "[\"stringData\"][\"$k\"]"
    done
    ```

12. From the repo root, in zsh (type `zsh` first), write the credentials Secret
    from 1Password. It replaces the placeholder the PR contains. Replace the
    `op://` reference with the real item. The `jq` step refuses anything that is
    not a tunnel credentials file:

    ```sh
    ( set -o pipefail
      f=kubernetes/apps/personal-apps/reports-share/app/tunnel-credentials.sops.yaml
      op read 'op://<vault>/<item>/credentials.json' \
        | jq -Rs 'if (try (fromjson | (.AccountTag and .TunnelSecret and .TunnelID)) catch false) then {apiVersion: "v1", kind: "Secret", metadata: {name: "reports-share-tunnel", namespace: "reports-share"}, type: "Opaque", stringData: {"credentials.json": .}} else error("not a tunnel credentials file") end' \
        | sops encrypt --filename-override "$f" --input-type json --output-type yaml /dev/stdin > "$f.tmp" \
        && [ "$(yq '[.stringData[] | test("^ENC\\[")] | all' "$f.tmp")" = true ] \
        && mv "$f.tmp" "$f" || { rm -f "$f.tmp"; echo "failed: $f was not written" >&2; false; } )
    ```

13. Re-sign the MapKit token so its `origin` claim also names `share.<zone>` (see
    "Apple Maps (the mapkit part)", and type `zsh` first). Without it the maps
    on the guest view show a note.
14. Commit the two changed files (`cluster-secrets.sops.yaml`,
    `tunnel-credentials.sops.yaml`) and merge. Then test end to end:
    - `kubectl -n reports-share logs deploy/cloudflared` says `Registered tunnel
      connection` and has no `AccessJWTValidator` errors;
    - `curl -sI https://share.<zone>/` answers 302 to `<team>.cloudflareaccess.com`;
    - in a private browser window, `https://share.<zone>/` shows the one-time PIN
      page;
    - the listed email gets a code, gets in, and `fay-ave` loads;
    - an email that is not listed gets no email with a code.

After changing any `SECRET_SHARE_*` key later, run
`kubectl -n reports-share rollout restart deploy/cloudflared`: the routing's
hash does not change when only a key does.

Never add a private-network route (a CIDR or hostname route) to this tunnel:
WARP traffic bypasses the Access check.

Never create the DNS record with `cloudflared tunnel route dns`: Terraform owns
it.

The Access login is in `terraform/dns/access.tf`: a self-hosted application for
the whole host `share.<zone>` (no path), session 24 hours, One-time PIN as the
only login method with automatic redirect to it, hidden from the app launcher,
and one Allow policy that lists only the guest emails. There is no bypass and no
other policy. Change everything except the guest list in Terraform.

The guest list lives in the dashboard. `reports_share_guest_emails` only seeds it
when the policy is created; Terraform then ignores the policy's emails, so an
apply never undoes a dashboard edit. Keep at least one address in the tfvars
list: it is also the switch that keeps the share on.

- Add a guest: Zero Trust, Access, Policies, "reports-share guests", edit, add
  the address under Include as one more "Emails" value, save. It works at once.
  Add single addresses only: never a domain, "Everyone" or another rule.
- Remove a guest: delete the address from the same policy and save, then end
  their current login, which otherwise lasts up to 24 hours: Zero Trust, Team &
  resources, Users, pick the user, revoke the session (the menus move, so search
  the dashboard for "Users" if it differs).

Turn the whole share off, fastest first:

- Set `reports_share_guest_emails = []` and run `just dns apply`. The name, the
  Access application and the policy go together (the name first, then the
  application), so the share stops resolving and the edge refuses everyone. The
  one-time PIN method stays; it is account-wide.
- Or set `reports_share_tunnel_id` to `null` and apply. That destroys the same
  three and also the one-time PIN method, if Terraform created it, which other
  Access applications may use. Set `reports_share_otp_idp_id` first if they do.
- Or remove `share` from the parts of `app-platform/apps/reports.yaml` and delete
  the folder `reports-share/` (the port, Service and cloudflared go away). Do
  the first route too: remove the tunnel and email lines from `tunnel.auto.tfvars`
  and run `just dns apply`, then `cloudflared tunnel delete reports-share`.

To finish, also remove every `SECRET_SHARE_*` key (six in all) from `cluster-secrets`,
and delete the `reports-share` Namespace by hand: it is prune-disabled, so it
stays behind. If you turned the share off in the dashboard (deleted the
application or the policy) instead, set `reports_share_guest_emails = []` before
the next apply, or Terraform recreates them. A recreated policy starts again
from the tfvars list, not from the list you kept in the dashboard.

Turning the share back on creates a new Access application with a new aud tag.
After the apply, from the main checkout, update the one key and restart
cloudflared (in zsh; commit and merge the changed `cluster-secrets.sops.yaml`
like step 14):

```sh
terraform -chdir=terraform/dns output -raw reports_share_access_aud \
  | jq -Rs . \
  | sops set --value-stdin kubernetes/components/sops/cluster-secrets.sops.yaml '["stringData"]["SECRET_SHARE_ACCESS_AUD"]'
kubectl -n reports-share rollout restart deploy/cloudflared
```

#### IDs for share-admin

The service that edits the guest list (`integrations/reports-share-admin`) needs
three IDs as `cluster-secrets` keys: `SECRET_SHARE_ACCESS_APP_ID` (the Access
application), `SECRET_SHARE_ACCESS_POLICY_ID` (the guest policy) and
`SECRET_SHARE_ACCESS_ACCOUNT_ID` (the Cloudflare account). They are IDs, not
credentials.

Outputs reach the state only through an apply, so after the merge run
`just dns apply` once (it changes no resource; it only stores the new outputs).
Then read them from the main checkout (no `sops exec-env` needed):

```sh
terraform -chdir=terraform/dns output -raw reports_share_access_app_id
terraform -chdir=terraform/dns output -raw reports_share_access_policy_id
terraform -chdir=terraform/dns output -raw reports_share_access_account_id
```

While the share is off (no application or policy exists) the first two fail
with "not found"; that is expected. Run the loop below from the checkout that
holds the Terraform state (the main checkout; a worktree has no state and the
outputs come back empty), with the share on. In zsh or bash, from the repo
root, it sets all three keys. Nothing is printed. It stops at the first output
that is missing or does not look like an ID (letters, digits and dashes, 8 to
64), so a null or empty output is never written into `cluster-secrets`:

```sh
cs=kubernetes/components/sops/cluster-secrets.sops.yaml
for pair in reports_share_access_account_id:SECRET_SHARE_ACCESS_ACCOUNT_ID \
            reports_share_access_policy_id:SECRET_SHARE_ACCESS_POLICY_ID \
            reports_share_access_app_id:SECRET_SHARE_ACCESS_APP_ID; do
  out=${pair%%:*}; key=${pair##*:}
  id="$(terraform -chdir=terraform/dns output -raw "$out")" || { echo "no output $out: stopped" >&2; break; }
  [[ "$id" =~ ^[A-Za-z0-9-]{8,64}$ ]] || { echo "$out is not an ID: stopped" >&2; break; }
  jq -n --arg v "$id" '$v' | sops set --value-stdin "$cs" "[\"stringData\"][\"$key\"]" || { echo "sops failed for $key: stopped" >&2; break; }
done
```

A new application or policy (see turning the share back on) has new IDs: set
the keys again.

#### Claims mode, the assistant and the Share panel

The `share` part sets these on the app container (the validator accepts exactly
these `GUEST_` variables and `SHARE_ADMIN_HOSTS`, and refuses the same names in
`env`):

| Variable | Value | Why |
| --- | --- | --- |
| `GUEST_ACCESS_MODE` | `claims` | The app reads the guest's email from the Access token that cloudflared has already checked, and gives each guest their own collections. The pod has no way out to fetch Cloudflare's signing keys, so the default mode (`keys`) cannot work here |
| `GUEST_ACCESS_AUD`, `GUEST_ACCESS_TEAM` | `${SECRET_SHARE_ACCESS_AUD}`, `${SECRET_SHARE_ACCESS_TEAM}` | The same `cluster-secrets` keys cloudflared's routing uses: the audience and the team the token must name |
| `GUEST_AGENT` | `on` | The Ask assistant for guests |
| `SHARE_ADMIN_HOSTS` | `<HOST>.<zone>` (the LAN host) | The Share panel, and every change to the guest list, answer on this host only |

No setting names the guests. At the first start in claims mode, when the app has
no guest list yet (`guests.json` in its data folder), it asks share-admin for the
emails on the Access policy, gives each of them today's `GUEST_COLLECTIONS` and
writes the list. Until share-admin answers, the app writes nothing, the guest
port refuses every guest, and the app asks again every 60 seconds. After that
the Share panel keeps the list, and every change to it also goes through
share-admin. Because claims mode seeds and edits the guest list only through
share-admin, the validator refuses the `share` part in claims mode without the
`share-admin` part. The details are under "The first guest list" in the reports
README of the apps repo.

`GUEST_AGENT=on` goes live with this change: the apps image the entry follows
already has the guest assistant, so at the merge guests get the "Ask about this
report" panel on the guest view (it costs money per question, within the
per-guest and per-day limits in the apps README), and the family sees the
read-only "Guest questions" list on the LAN host. Step 2 checks both.

`GUEST_TRUSTED_PEERS` is unset (the policy above is the lock) and
`GUEST_RUN_TIMEOUT_MS` keeps the app's default. The memory limit of the reports
entry is 3Gi (it was 2Gi), with a 1Gi request, for two agent runs at once, one
for the family and one for a guest.

##### Set it up (the owner)

Do this after the share-admin set-up above is done and `sa GET /guests` works:
the app takes its first guest list through share-admin. The entry follows the
apps repo's `main`, so merge only after mihirsamdarshi/apps#125 (the first
guest list from share-admin) is on that `main`. An image without it writes an empty guest list
at the first start in claims mode and never seeds again, and every guest (the
realtor too) would be turned away until you add them again in the Share panel
or edit `guests.json`. `scripts/validate-apps.sh` fails until the two keys the part
substitutes (`SECRET_SHARE_ACCESS_AUD`, `SECRET_SHARE_ACCESS_TEAM`) are in
`cluster-secrets` as encrypted values; step 11 of the share part's set-up above
set them.

1. Merge. Flux restarts the reports pod (a short break for the LAN and family
   hosts).
2. Check:

   ```sh
   kubectl -n reports rollout status deploy/reports
   kubectl -n reports logs deploy/reports | grep -E 'guest view|guest list|still waiting for share-admin'
   ```

   The log shows a line `guest view ... claims` (the guest port started in
   claims mode) and `share: wrote the first guest list (guests.json) for N
   guest(s) from Cloudflare's guest policy`, with N the number of emails that
   `sa GET /guests` (step 6 of the share-admin set-up) lists. N is smaller only
   if the log also says it left entries out (an entry that is not a lower-case
   plain `name@domain.tld`). If the log shows `share: no guest list yet, so
   nobody may enter: share-admin did not give Cloudflare's guest list
   (<reason>); trying again every 60 s` instead, or later `seed: still waiting
   for share-admin since <time>, <tries> tries`, the guest port refuses every guest
   until share-admin answers: check `sa GET /guests` and the share-admin pod.
   While the app waits, do not add a guest in the Share panel unless that guest
   should be the whole list: the first guest added starts the list, and the app
   then stops asking Cloudflare. Then:

   - Open `https://reports.<local zone>/`: the **Share** button is in the top
     bar, and the Guests tab lists your guests with no "Waiting for the first
     guest list from Cloudflare" notice. From the LAN,
     `curl -s https://reports.<local zone>/api/share/guests | jq -r '"seed: \(.seed)", (.guests[] | "\(.email) \(.where) \(.by) \(.collections | join(","))")'`
     prints `seed: null`, then every email of `sa GET /guests` with `both` (in
     the app's list and in Cloudflare), `seed` (the first guest list wrote it)
     and today's `GUEST_COLLECTIONS` (`fay-ave`). Open
     `https://reports.family.<zone>/`: there is no Share button.
   - The realtor can still sign in: ask them to open `https://share.<zone>/`
     (or use a test address that you added in the panel), sign in with the
     one-time PIN, and see the shared collection.
   - The guest port is closed to everyone but cloudflared. Get the pod IP with
     `kubectl -n reports get pod -l app.kubernetes.io/name=reports -o jsonpath='{.items[0].status.podIP}'`
     and its node with `-o jsonpath='{.items[0].spec.nodeName}'`. Each of these
     must time out (curl prints `000`), because `/healthz` on the guest port
     answers 200 to anyone who can reach it:
     - from the `default` namespace (this timed out before this change too; it
       shows the allow rule is narrow). The namespace enforces Pod Security
       `restricted`, so the pod needs the security fields (curl prints `000` when
       it times out):
       `kubectl -n default run policy-check --rm -it --restart=Never --image=curlimages/curl --override-type=strategic --overrides='{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":100,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"policy-check","securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}' -- curl -m 5 -s -o /dev/null -w '%{http_code}\n' http://<pod ip>:3001/healthz`
     - from the node (replace `<node>`; this answered 200 before this change,
       because of allow-localhost, and must time out now):
       `kubectl -n kube-system debug node/<node> -it --image=curlimages/curl -- curl -m 5 -s -o /dev/null -w '%{http_code}\n' http://<pod ip>:3001/healthz`
       (a node debugger shares the host's namespaces, which only `kube-system`
       allows). It prints `000` on a timeout. Delete the debugger pod afterwards:
       `kubectl -n kube-system get pods | grep node-debugger`, then
       `kubectl -n kube-system delete pod <name>`
     - from a pod in the `reports` namespace that has no name label (this is
       the case the `NotIn` rule covers, and the one thing this change assumes
       about Cilium instead of knowing: that `NotIn` matches a pod with no such
       label. It answered 200 before this change. The namespace is restricted, so the pod
       needs the pod security fields in `--overrides`):
       `kubectl -n reports run policy-check --rm -it --restart=Never --image=curlimages/curl --overrides='{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":100,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"policy-check","image":"curlimages/curl","command":["curl","-m","5","-s","-o","/dev/null","-w","%{http_code}\\n","http://<pod ip>:3001/healthz"],"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}'`
       If it prints `200`, the deny does not cover label-less pods: stop, do not
       share anything new, and tell the maintainers. If the cluster refuses the
       pod, adjust the fields; a refusal is not a pass.
   - The main port is untouched: the pod is `1/1 Running` with no probe
     failures (`kubectl -n reports describe pod -l app.kubernetes.io/name=reports`,
     Events), and `curl -s -o /dev/null -w '%{http_code}\n' https://reports.<local zone>/healthz`
     prints `200`. The probes go to port 3000.
   - The guest assistant is on: a guest's page (open `https://share.<zone>/` as
     the realtor or a test guest) shows "Ask about this report", and
     `curl -s -o /dev/null -w '%{http_code}\n' https://reports.<local zone>/api/guest-questions`
     prints `200` while the same path on `https://reports.family.<zone>/` prints
     `404`.
   - `kubectl -n reports get deploy reports -o jsonpath='{.spec.template.spec.containers[0].resources.limits.memory}'`
     prints `3Gi`.

This is a network rule: `kubectl exec`, `port-forward` and debug containers
bypass network rules, so it limits pods and the node, not a cluster admin.

If a guest is turned away after the first start, the list in the app is wrong or
empty. Add the guest in the Share panel, or see "The first guest list" in the
reports README (`guests.json` in the data folder).

### share-admin

A small service that edits the guest list of the reports share
(`share.<zone>`). It holds the Cloudflare API token, so the reports app does
not. The Share panel in the app (a later change) asks it to list guests, replace
the list, end all guest sessions and look up a guest's last sign-in. Its code,
routes and rules are in `integrations/reports-share-admin/README.md`.

It runs outside the platform, like `claude-proxy`, in its own Namespace
`share-admin` (folder `personal-apps/share-admin/`, Flux Kustomization
`share-admin` in `flux-system`):

- one Deployment (one replica, `Recreate`, uid 1000, read-only root, all
  capabilities dropped, no service-account token), image pinned by digest
  (`app/deployment.yaml`; to update, pin the digest of a newer `sha-<commit>`
  tag from the "Reports share-admin" workflow);
- the Service `share-admin` on 8080. The health port (8081) is not in the
  Service; the kubelet probes the pod. `ALLOWED_HOSTS` is the Service's exact
  name and port, `share-admin.share-admin.svc.cluster.local:8080`;
- the token in the Secret `share-admin-credentials` (key `cloudflare-token`),
  mounted as the file `/run/credentials/cloudflare-token`, read again on every
  request;
- the three IDs as environment from `cluster-secrets`
  (`SECRET_SHARE_ACCESS_ACCOUNT_ID`, `SECRET_SHARE_ACCESS_POLICY_ID`,
  `SECRET_SHARE_ACCESS_APP_ID`);
- the image pull Secret `apps-ghcr` (this namespace is one of the `inputs` of
  `apps-pull`);
- a CiliumNetworkPolicy. Ingress: 8080/TCP only from the reports app pod (label
  `app.kubernetes.io/name: reports` in the namespace `reports`, not the weekly
  job pod, the backup pods or anything else), and 8081/TCP from the node
  (kubelet probes). Cilium always lets the node and host-network processes
  reach every port of a pod on it, so the policy also denies the node on 8080
  (`ingressDeny`); a deny wins. Egress: cluster DNS, and 443/TCP to Cloudflare's published
  IPv4 ranges (the list the cloudflared policy uses), nothing else.

On the reports side the `share-admin` part adds `SHARE_ADMIN_URL`
(`http://share-admin.share-admin.svc.cluster.local:8080`) to the app container
and a second policy `reports-share-admin` that lets the app pod, and no other
pod, send to the share-admin pods on 8080/TCP. The validator checks both
(`scripts/validate-apps.sh`). `RESEND_KEY_FILE` is unset: the notification
routes answer 501 until the email change.

#### Set it up (the owner)

Nobody but the owner handles the token; do not paste it into chat. Do steps 1
to 4 on the branch of the PR that adds this folder, before it merges. Until the
token file is replaced, the Secret holds a dummy string that Cloudflare
rejects, and until the three keys exist the service stops at start and the
Flux Kustomization stays not ready.

1. Create the token in the Cloudflare dashboard as an **account** API token:
   the account, Manage Account, Account API Tokens, Create Token, Create Custom
   Token (not a user token under My Profile). An account token belongs to the
   account, cannot reach another account, and survives changes to users. Give
   it exactly two permissions: **Access: Apps and Policies: Edit** and
   **Access: Audit Logs: Read**. Account Resources: include this account only.
   TTL: one year from today. No client IP filter. The value is shown once.
2. Save it in 1Password: item "Cloudflare Reports Share Admin" in the Private
   vault, field `credential` (the owner's own item name, not a secret; use
   yours in the `op://` reference in step 4). Set a calendar reminder 90 days before the
   expiry (see "Rotation").
3. Set the three `cluster-secrets` keys. Run `just dns apply` once (with the
   share on), then run the checked loop in "IDs for share-admin" above, from the
   main checkout (the one that holds the Terraform state), in zsh or bash from
   the repo root. It writes `SECRET_SHARE_ACCESS_ACCOUNT_ID`,
   `SECRET_SHARE_ACCESS_POLICY_ID` and `SECRET_SHARE_ACCESS_APP_ID`, and stops
   on any output that is missing or not an ID.

4. Write the Secret from 1Password. It replaces the dummy file in the PR. The
   token is never written to a file: `sops encrypt` reads it from the pipe and
   writes to `<file>.tmp`, and `mv` puts it in place only when every stage
   succeeded and the output holds `ENC[`. Run it from the repo root in bash or
   zsh:

   ```sh
   ( set -o pipefail
     f=kubernetes/apps/personal-apps/share-admin/app/credentials.sops.yaml
     op read 'op://Private/Cloudflare Reports Share Admin/credential' \
       | kubectl create secret generic share-admin-credentials --namespace share-admin --from-file=cloudflare-token=/dev/stdin --dry-run=client -o yaml \
       | yq '.type = "Opaque" | .stringData = (.data | map_values(@base64d)) | del(.data) | del(.metadata.creationTimestamp)' \
       | sops encrypt --filename-override "$f" --input-type yaml --output-type yaml /dev/stdin > "$f.tmp" \
       && grep -q 'ENC\[' "$f.tmp" && mv "$f.tmp" "$f" || { rm -f "$f.tmp"; echo "failed: $f was not written" >&2; false; } )
   ```

   Check the shape only, never the value:

   ```sh
   sops decrypt kubernetes/apps/personal-apps/share-admin/app/credentials.sops.yaml | yq '.stringData | keys'
   # - cloudflare-token
   ```

5. Commit `credentials.sops.yaml` and `cluster-secrets.sops.yaml` and merge. Then
   check:

   ```sh
   flux get ks share-admin -n flux-system
   kubectl -n share-admin get deploy,pod,svc
   kubectl -n share-admin logs deploy/share-admin   # a "listening" line; never a token
   kubectl -n share-admin get secret apps-ghcr      # the pull Secret copy
   ```

   If the Secret `apps-ghcr` is missing (`apps-pull` ran before the Namespace
   existed), the pod stays in `ImagePullBackOff`. Run
   `flux-operator reconcile resourceset apps-pull -n flux-system` and check again.

6. End-to-end check (rollout step 12), with two test addresses you control, A
   and B, that are not real guests. Only the reports app pod may call the
   service, so run the calls inside it (the Host is then the exact Service name):

   ```sh
   sa() { kubectl -n reports exec deploy/reports -- bun -e "const r=await fetch('http://share-admin.share-admin.svc.cluster.local:8080$2',{method:'$1',headers:{'content-type':'application/json'},body:${3:-undefined}});console.log(r.status,await r.text())"; }
   sa GET /guests
   ```

   a. A `PUT` replaces the whole list, so keep every real guest in it. Add A and
      B: `sa PUT /guests 'JSON.stringify({emails:["<real guest>","a@example.test","b@example.test"]})'`.
      Use your own addresses for A and B, in lower case.
   b. In two separate private browser windows, open `https://share.<zone>/` and
      sign in as A and as B with the one-time PIN. Both reach the page.
   c. Remove A, then end the sessions:
      `sa PUT /guests 'JSON.stringify({emails:["<real guest>","b@example.test"]})'`,
      then `sa POST /revoke`.
   d. Reload A's window. A must be refused, and a new PIN is not sent to A.
   e. Reload B's window. B's session must have ended too (B is asked to sign in
      again; that is the documented cost of the narrow token). If B is still in,
      the revoke did not end sessions of PIN logins: stop, tell the maintainers,
      and do not rely on removal alone (a removed guest stays in for up to 24
      hours).
   f. Sign B in again; it works.
   g. Remove B the same way (`PUT` without B, `POST /revoke`). `sa GET
      '/last-login?email=b@example.test'` shows the time B last got in.
   h. From the main checkout, `just dns plan` must show no change to the policy.
      If it shows one, the write-back changed a field: stop and look.
   i. Check that the policy drops everyone else. Get the pod IP with
      `kubectl -n share-admin get pod -l app.kubernetes.io/name=share-admin -o jsonpath='{.items[0].status.podIP}'`
      and its node with `-o jsonpath='{.items[0].spec.nodeName}'`.
      - From a pod in the `default` namespace the call must time out (the
        namespace enforces Pod Security `restricted`, hence the overrides; curl
        prints `000`):
        `kubectl -n default run policy-check --rm -it --restart=Never --image=curlimages/curl --override-type=strategic --overrides='{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":100,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"policy-check","securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}' -- curl -m 5 -s -o /dev/null -w '%{http_code}\n' http://<pod ip>:8080/guests`
      - From the node, with a debug pod on it (replace `<node>`):
        `kubectl -n kube-system debug node/<node> -it --image=curlimages/curl -- curl -m 5 -s -o /dev/null -w '%{http_code}\n' http://<pod ip>:8080/guests`
        (a node debugger shares the host's namespaces, which only `kube-system`
        allows) must time out (`000`, the `ingressDeny`), and the same with
        `http://<pod ip>:8081/healthz` must print `200`. Then delete the debugger
        pod: `kubectl -n kube-system get pods | grep node-debugger`, then
        `kubectl -n kube-system delete pod <name>`.

#### Rotation and expiry

The token expires one year after creation. Set a reminder for 90 days before
that date. To rotate: create a new account token with the same two permissions
(step 1), save it in the same 1Password item, repeat step 4 (it overwrites the
file), merge, and wait about a minute for the mounted file to update (no
restart). Then delete the old token in Cloudflare. After expiry, writes fail with
an `alert` log line (`"reason":"token-rejected"`; the answer's error code is
`token_rejected`) and the guest list stays as it is. Nothing pages on alert lines
yet: look at the logs. After a rotation, wait 30 seconds, then `sa GET /guests`
(step 6) must answer 200.

If Cloudflare changes its published ranges (`https://www.cloudflare.com/ips-v4`),
update `share-admin/app/networkpolicy.yaml` and the cloudflared policy together.

To retire: remove `share-admin` from the parts of the reports entry, remove
`./share-admin` from `personal-apps/kustomization.yaml` and the folder, remove
`share-admin` from the `inputs` of `apps-pull`, delete the token in Cloudflare
and delete the `share-admin` Namespace by hand (prune-disabled).

### Creating ghcr-apps-read

The one registry credential: a classic GitHub token with only `read:packages`,
created by the owner with a one-year expiry (set a calendar reminder a month
before). It can read every private package of the account. Never paste it into
chat, a log or Git. `scripts/validate-apps.sh` fails until
`app-platform/app/ghcr-apps-read.sops.yaml` exists, is encrypted and carries the
label `reconcile.fluxcd.io/watch: Enabled` (without it a rotated token reaches
the copies only at the ResourceSet's next interval of 60 minutes).

Create it from the repo root, in bash or zsh, with `GHCR_READ_TOKEN` (and optionally `GHCR_READ_USER`, default
`mihirsamdarshi`) exported. The plaintext token is never written to a file:
`sops encrypt` reads it from the pipe, and its output goes to `<path>.tmp` first.
Only when every stage succeeded (`pipefail`) and the output holds `ENC[` does
`mv` put it in place, so a failure (an unset token, a missing age recipient, a
sops error) leaves no new file and keeps an existing one, which matters when you
rotate. Without `pipefail` an unset token would still produce a validly
encrypted file with a null value (the validator rejects it). The subshell keeps
`pipefail` out of your interactive shell:

```sh
( set -o pipefail
  f=kubernetes/apps/flux-system/app-platform/app/ghcr-apps-read.sops.yaml
  kubectl create secret docker-registry ghcr-apps-read --namespace flux-system --docker-server=ghcr.io --docker-username="${GHCR_READ_USER:-mihirsamdarshi}" --docker-password="${GHCR_READ_TOKEN:?set GHCR_READ_TOKEN}" --dry-run=client -o yaml \
    | yq '.stringData[".dockerconfigjson"] = (.data[".dockerconfigjson"] | @base64d) | del(.data) | .metadata.labels["reconcile.fluxcd.io/watch"] = "Enabled"' \
    | sops encrypt --filename-override "$f" --input-type yaml --output-type yaml /dev/stdin > "$f.tmp" \
    && grep -q 'ENC\[' "$f.tmp" && mv "$f.tmp" "$f" || { rm -f "$f.tmp"; echo "failed: $f was not written" >&2; false; } )
```

`--filename-override` makes sops apply the `.sops.yaml` rule for that path. The
credential goes under `stringData`, like every other SOPS Secret here:
`flux build ks` cannot mask an encrypted value under `data`. The rule encrypts
`data` and `stringData` only, so the label stays readable. Prefer reading the
token with `op read` inside the same pipeline over an exported variable. Check
only the shape, never the values:
`sops decrypt kubernetes/apps/flux-system/app-platform/app/ghcr-apps-read.sops.yaml | yq '.stringData | keys'`
prints `.dockerconfigjson`. Never put a bogus `ghcr.io` credential in it (every
RSIP uses it) and never delete it while any entry has `pullsecret`. Do not add
Talos registry credentials for `ghcr.io`: a stale token would break every
`ghcr.io` pull on every node.

**Rotation:** check `apps-pull` is Ready, re-encrypt `ghcr-apps-read`, check
`apps-pull` is Ready again and that a copy's `resourceVersion` changed. Update
the expiry reminder. **An expired token** makes new pulls of private `apps`
images fail (`ImagePullBackOff`, reported by the Alert as a failed health check)
and the RSIPs fail; running pods keep running and public `ghcr.io` images are
unaffected.

### Rules that keep a platform app safe

- Never rename or change the namespace of an existing entry: it starts a new,
  empty app. The validator compares with `main` on pull requests, and a deleted
  or renamed entry file fails unless it is listed in `retired.txt`.
- **Never delete or recreate an owner Kustomization before the Git object that
  renders it is gone.** A handoff (an app adopted from a hand-written
  Kustomization, as in the Quilt migration) goes: suspend the old owner with
  `flux suspend` (never `kubectl patch`), add the entry, check that the live
  objects kept their UIDs, and only then remove the old Kustomization.
- Never set `fluxcd.controlplane.io/force` on a ResourceSet or what it renders.
  Never render a Namespace from a ResourceSet. Never rename `app-platform`,
  `apps` or `apps-pull`; to retire the whole platform, suspend the ResourceSets
  first (`flux-operator suspend resourceset <name> -n flux-system`).
- Never remove `fluxcd.controlplane.io/prune: disabled` from the `apps-pull`
  Secret template: a stale copy is harmless, a missing one during an outage is
  not.
- Never give an app a Secret (the `mapkit` part's MapKit JS token is the one
  exception), and never set `netpol: false` without a stated reason. Never add a `world` entity or a bare `0.0.0.0/0` rule to a policy.
- Do not add any CI-to-tailnet path (Receiver, `tag:ci`, an OAuth client) until
  the tailnet policy has been narrowed in its own project. Deploys poll every 2
  minutes meanwhile.
- Retire an app: delete its entry and its line in `apps/kustomization.yaml`, and
  list its name in `app-platform/retired.txt` in the same PR. The validator
  fails on a pull request when an entry file that exists on `main` is gone and
  not listed, which also catches a rename (a delete plus an add). The workload
  keeps running without updates; delete its objects by hand, including the
  prune-disabled `apps-ghcr` Secret. The PVC, PV, Namespace folder and the NAS
  restic directory stay on purpose.
- A rollback is `pin: sha256:…` in the entry (the digest of `main`'s manifest),
  or a revert in `apps`. It does not roll data back.

### Validate

```sh
scripts/validate-kubernetes.sh        # everything, including the next line
scripts/validate-apps.sh              # the entries, both ResourceSets, what they render
scripts/validate-apps.sh --self-test  # the fixtures under scripts/validate-apps/fixtures
```

The validator needs `flux-operator` (its version must equal the operator chart
tag), `flux`, `kustomize`, `kubeconform`, `yq`, `jq`, `gitleaks` and `promtool`;
`mise install` provides them. It also unit-tests the alert rules
(`promtool test rules`, with the metric names flux-operator really exports). The ResourceSets render offline with
`flux-operator build rset -f <resourceset> --inputs-from-provider <static RSIP>`;
the CLI only takes `Static` providers, so the validator rewrites the type and
injects a fake `digest`. The CLI exits 1 with "no objects were generated" when
an input renders nothing; the controller accepts that.

## Bundle apps

An app's CI publishes an image and a private OCI bundle that holds its
Kubernetes manifests. Flux pulls the bundle and applies it as a service account
that can only change objects in that namespace. New apps use the platform above
instead.

No app runs this way now. Quilt Planner did until it moved onto the platform.
Its entry is the ResourceSetInputProvider `app-quilt-planner` in
`app-platform/apps/quilt-planner.yaml`. The ResourceSet `apps` renders it into
the Kustomization `flux-system/app-quilt-planner`, which deploys the image
`ghcr.io/<owner>/apps/quilt-planner` at its `main` tag, pulled with the copied
Secret `apps-ghcr`. `quilt-planner/` keeps the parts that are still Git-defined:
the StorageClass, the LAN route and the backup. The sections below still use
them as examples.

### How it fits together

- `kubernetes/components/personal-namespace`: the Namespace, with the
  `restricted` Pod Security level and pruning disabled. The app's
  `kustomization.yaml` names it with `namespace:`.
- `<app>-bootstrap` (in the app's `ks.yaml`): a Flux Kustomization that applies
  `<app>/app` and fills in the next component from its `postBuild.substitute`.
- `kubernetes/components/personal-app`: the reconciler's ServiceAccount, Role
  and RoleBinding, the OCIRepository for the bundle, and the Kustomization
  `<app>` that applies it.
- The registry pull Secret is the app's own file, SOPS-encrypted in
  `<app>/app/`.

The Role covers Services, PVCs, ConfigMaps and Deployments, plus read access to
ReplicaSets and Pods for the health check. Through the API it cannot read
Secrets, create Roles or HTTPRoutes, or change anything outside the namespace.
It is not a sandbox: the bundle can still run pods that mount the namespace's
Secrets. The bundle's Kustomization has
`deletionPolicy: Orphan`: deleting it leaves the app and its data running. It
and the OCIRepository are also `prune: disabled`, so Flux never deletes them
for you.

### Add an app

`<app>` is the app name. It is also the namespace, and the bundle's Deployment
must use it as its name (the health check waits for it).

1. Add `- ./<app>` to `personal-apps/kustomization.yaml`.
2. Create `personal-apps/<app>/kustomization.yaml`:

    ```yaml
    apiVersion: kustomize.config.k8s.io/v1beta1
    kind: Kustomization
    namespace: <app>
    components:
        - ../../../components/personal-namespace
    resources:
        - ks.yaml
    ```

3. Create `personal-apps/<app>/ks.yaml`:

    ```yaml
    apiVersion: kustomize.toolkit.fluxcd.io/v1
    kind: Kustomization
    metadata:
        name: <app>-bootstrap
    spec:
        interval: 1h
        path: ./kubernetes/apps/personal-apps/<app>/app
        postBuild:
            substitute:
                APP: <app>
                OCI_REPO: ghcr.io/<owner>/<repo>
        prune: true
        sourceRef:
            kind: GitRepository
            name: flux-system
            namespace: flux-system
        targetNamespace: <app>
        wait: false
    ```

4. Create `personal-apps/<app>/app/kustomization.yaml`:

    ```yaml
    apiVersion: kustomize.config.k8s.io/v1beta1
    kind: Kustomization
    components:
        - ../../../../components/personal-app
    resources:
        - registry.sops.yaml
    ```

5. Create `personal-apps/<app>/app/registry.sops.yaml` from a token that can read
   the bundle's package (`read:packages`). Keep the token in an environment
   variable. Never paste it into chat, logs or Git. Encrypt before you stage
   the file:

    ```sh
    kubectl create secret docker-registry <app>-registry --namespace <app> \
      --docker-server=ghcr.io --docker-username=<github-user> \
      --docker-password="$GHCR_READ_TOKEN" --dry-run=client -o yaml \
      > kubernetes/apps/personal-apps/<app>/app/registry.sops.yaml \
      && sops encrypt --in-place kubernetes/apps/personal-apps/<app>/app/registry.sops.yaml
    ```

Variables for `postBuild.substitute`:

| Variable          | Default            | Meaning                                            |
| ----------------- | ------------------ | -------------------------------------------------- |
| `APP`             | required           | Name, namespace and Deployment name                |
| `OCI_REPO`        | required           | `ghcr.io/<owner>/<repo>`, without `oci://`         |
| `OCI_TAG`         | `main`             | Tag to follow                                      |
| `RECONCILER_NAME` | `<app>-reconciler` | Set only to adopt objects that already have a name |
| `REGISTRY_SECRET` | `<app>-registry`   | Set only to adopt objects that already have a name |

Add a patch in `app/kustomization.yaml` for anything else. Examples, both
checked with `scripts/validate-kubernetes.sh`:

```yaml
patches:
    - target:
          kind: Role
      patch: |-
          - op: add
            path: /rules/-
            value:
              apiGroups: [batch]
              resources: [cronjobs]
              verbs: [get, list, watch, create, update, patch, delete]
    - target:
          kind: OCIRepository
      patch: |-
          - op: remove
            path: /spec/ref/tag
          - op: add
            path: /spec/ref/semver
            value: ">=1.0.0"
```

After the merge, `flux get ks -n <app>` shows `<app>-bootstrap` and `<app>`
Ready, and `kubectl -n <app> get ocirepository` shows the bundle revision.

### Storage

The app's PVC belongs to its bundle. For data that matters, use the shared
`local-retain` class (`storage/local-path-provisioner`): node-local, and a
deleted claim keeps the volume. `local-path` deletes the volume with the claim.
Also give that PVC the annotation `kustomize.toolkit.fluxcd.io/prune: disabled`,
as Quilt's `quilt-data` has. Quilt predates the shared class and has its own
`quilt-local-retain` in `quilt-planner/app/storage-class.yaml`; do not copy it.

### Reach it from the tailnet or from family

Each is a separate Flux Kustomization that applies a small folder into the app's
namespace. Copy Quilt's LAN folder and change the names. Whether and how to
expose an app is the owner's decision, so confirm it first.

A bundle cannot create routes: the reconciler's Role has no rule for
HTTPRoutes, so a bundle that ships one fails to apply. Exposure is added in
this repo, with the folders below. Keep it that way, because the gateways
accept routes from every namespace and a route in an app's namespace can attach
to `envoy-internal` or `envoy-family` without any other change. Restricting
`envoy-family` to labelled namespaces is a possible follow-up.

- **Tailnet:** Quilt's own tailnet endpoint (`quilt-planner/tailnet/`, the
  `quilts` Ingress on ProxyGroup `apps`) was retired in the move to the
  platform; the folder is in Git history. Apps are reached from the tailnet
  through the LAN subnet route and the internal address.
- **Family:** Quilt's family route now comes from the app platform (the entry's
  `family-route` and `family-route-legacy` parts). Its old folder
  `quilt-planner/family/` and its block in `network/family-apps/ks.yaml` are
  gone; they are in Git history. A bundle app's family route needs its own
  block in `network/family-apps/ks.yaml`, because it reads `cluster-secrets` in
  the `network` namespace. Two things must hold: the
  route's only parent is `envoy-family` in `network`, with no `sectionName`, and
  its hostnames sit under `${SECRET_FAMILY_DOMAIN}`. Never attach it to
  `envoy-internal`. See
  `network/family-apps/README.md`, which also explains the transitional names
  Quilt's route still lists.
- **LAN (`envoy-internal`):** copy `quilt-planner/internal/` and the
  `quilt-planner-internal` block in `network/internal-apps/ks.yaml`. It lives
  there for the same reason as the family one: the hostname needs
  `${SECRET_DOMAIN_LOCAL}` from `cluster-secrets` in `network`, and an app's own
  namespace must not hold that Secret. The route's parent is `envoy-internal`,
  section `https`, and its hostname is `<app>.${SECRET_DOMAIN_LOCAL}`, as for
  every other internal route. Do not also attach it to `envoy-family`.
- **No retries for writes:** both Quilt routes have two named rules, `reads`
  (GET and HEAD) and `writes` (everything else). The gateway-wide policy
  retries a request after a connection reset, which is only safe to replay for
  reads. A BackendTrafficPolicy next to each route sets `retry.numRetries: 0`
  on its `writes` rule. `mergeType: StrategicMerge` keeps compression,
  keepalive and timeouts from the gateway-wide policy. Copy the pair for any
  app whose writes are not idempotent.

### Backups

Nightly restic backups of an app's volume use the `volsync` component
(`kubernetes/components/volsync`), and apps with SQLite databases add the
`sqlite-export` component, which writes a consistent copy of each database
shortly before the backup. An app opts in with a `backup/` folder that includes
the components, plus one more Flux Kustomization in its `ks.yaml`:

```yaml
metadata:
    name: <app>-backup
spec:
    dependsOn:
        - name: <app>
          namespace: <app>
        - name: volsync
          namespace: volsync-system
    path: ./kubernetes/apps/personal-apps/<app>/backup
    postBuild:
        substitute:
            APP: <app>
            VOLSYNC_CLAIM: <the app's PVC name>
            VOLSYNC_NAMESPACE: <app>
            VOLSYNC_SCHEDULE: "<cron, UTC; 15 minutes after the previous app>"
            APP_UID: "<the app's uid, if not 568>"
            APP_GID: "<the app's gid, if not 568>"
            SQLITE_DBS: <databases, relative to the volume root>
            SQLITE_SCHEDULE: "<cron, UTC; 10 minutes before the backup>"
```

From `personal-apps/<app>/backup/` the component paths are
`../../../../components/volsync` and `../../../../components/sqlite-export`.
`quilt-planner/backup` is a working example. The volsync component's README has
the rest, including the first backup and restore.

### Rules that keep a move safe

- Never rename a Flux Kustomization or change its namespace. Flux sees a new
  object, and prunes the old one together with what it applied. Change only its
  `spec.path` when files move.
- Keep one namespace per app, and do not widen the reconciler's Role to
  cluster-wide kinds or to HTTPRoutes. That limit is most of the isolation.
- Do not remove `prune: disabled` from a Namespace, a StorageClass or a data
  PVC.
- Preview any change to `postBuild.substitute` before merging it. A mistyped
  `APP` creates a second OCIRepository and Kustomization next to the old pair,
  and an empty one drops the pair from the render. Nothing is pruned, but a
  typo leaves a duplicate to delete by hand, and nothing in CI catches a
  misspelled variable. No output and exit 0 mean no change; `created` or
  `deleted` lines mean a name changed:

    ```sh
    yq 'select(.metadata.name == "<app>-bootstrap") | .metadata.namespace = "<app>"' \
      kubernetes/apps/personal-apps/<app>/ks.yaml > /tmp/ks.yaml
    flux diff kustomization <app>-bootstrap -n <app> \
      --path ./kubernetes/apps/personal-apps/<app>/app --kustomization-file /tmp/ks.yaml
    ```

- To remove an app, delete its folder and its line in
  `personal-apps/kustomization.yaml`, then delete its OCIRepository and Kustomization
  by hand (`kubectl -n <app> delete kustomization,ocirepository <app>`). Both
  are `prune: disabled`, so Flux leaves them. The app's own objects, its PVC and
  the Namespace stay until you delete them too.
