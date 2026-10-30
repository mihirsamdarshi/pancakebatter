# Personal apps

Apps the owner writes and ships from their own repositories, one namespace per
app. There are two ways to run one:

- **Platform apps** (the default): the code lives in the private `apps`
  monorepo, CI publishes `ghcr.io/<owner>/apps/<app>`, and this repo generates
  the manifests from one shared template and a few settings. `hello` is the
  throwaway proof app. Everything below up to "Bundle apps" is about them.
- **Bundle apps**: the older way, where an app's CI also publishes a private OCI
  bundle with its manifests and a scoped service account applies it. Quilt
  Planner still runs this way until it moves onto the platform; see "Bundle
  apps" at the end.

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
- `kubernetes/apps/personal/<namespace>/`: the app's Namespace, Git-defined,
  Pod Security `restricted`, prune-disabled. Only the Namespace lives here.
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

2. Create `personal/<namespace>/kustomization.yaml` and add `- ./<namespace>` to
   `personal/kustomization.yaml`. The namespace is the app name unless the entry
   sets `namespace`:

    ```yaml
    apiVersion: kustomize.config.k8s.io/v1beta1
    kind: Kustomization
    namespace: <namespace>
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
| `namespace`                                     | `name`                                 | The app's namespace. The folder `personal/<namespace>/` must exist and carry the same name                                                                                                                                            |
| `parts`                                         | `[pullsecret, internal-route, backup]` | Pieces to add (below). `namespace` is not a part                                                                                                                                                                                      |
| `netpol`                                        | `true`                                 | The default-deny network policy. `false` needs a `netpolReason`                                                                                                                                                                       |
| `netpolReason`                                  | none                                   | Free text, required with `netpol: false`. The validator prints every exemption with its reason                                                                                                                                        |
| `egress`                                        | `none`                                 | `none` (DNS and the own namespace only) or `internet` (public addresses on all ports, never private ranges)                                                                                                                           |
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
| `vars.SQLITE_DBS`                               | none                                   | Space-separated database paths for `backup-sqlite`                                                                                                                                                                                    |
| `vars.VOLSYNC_SCHEDULE`, `vars.SQLITE_SCHEDULE` | none                                   | Explicit UTC cron strings, required with `backup` / `backup-sqlite`                                                                                                                                                                   |

Parts (`kubernetes/components/app-platform/`): `pullsecret` (a name only: the
Secret is rendered by `apps-pull`), `internal-route` (`<HOST>.${SECRET_DOMAIN_LOCAL}`
on `envoy-internal`, no retries for writes), `family-route` (only on request;
see `network/family-apps/README.md`; needs `vars.FAMILY_HOST`),
`family-route-legacy` (the transitional `family.${SECRET_DOMAIN_LOCAL}` name;
list it after `family-route`), `backup` (the `volsync` component) and
`backup-sqlite` (the `sqlite-export` component, with no service-account token).
The `netpol` and `egress` keys add the `netpol` and `netpol-egress-internet`
components after the parts, so an explicit `parts: []` still gets the policy.

### The container contract

The generated Deployment assumes it; the `apps` template enforces it.

- Listens on port 3000 and reads `$PORT`; serves `GET <HEALTH_PATH>` with 200
  when ready. The port is fixed on purpose: Flux substitution turns a numeric
  value into an integer, which the API rejects for an environment value.
- Writes only under `$DATA_DIR` (the PVC) and `/tmp` (a 128 Mi `emptyDir`). The
  root filesystem is read-only. Runs as a non-root uid, all capabilities dropped,
  `linux/amd64`, one replica with strategy `Recreate` (SQLite is single-writer).
- **Receives no Secrets**: no `valueFrom`, `secretKeyRef`, `envFrom` of a Secret
  or Secret volume, and `automountServiceAccountToken` is false on every pod. The
  only Secret a pod references is the `apps-ghcr` image pull Secret.
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
Tailscale, cluster). Nothing reaches the Kubernetes API, the NAS or other
namespaces. DNS remains a tunnelling channel for a compromised app. Prometheus
cannot scrape an app; that would be a reviewed addition.

Hubble is off in this cluster. To see drops, run `cilium-dbg monitor --type drop`
in the node's Cilium agent pod. Do not widen a policy to fix a drop without a
reviewed reason: use `egress: internet` for public services, and redesign for
anything private.

### Escape hatch

1. A new `vars` key or a new `components/app-platform/<part>` (a PR here).
2. `env`: plain extra environment through a generated patch.
3. `path: ./kubernetes/apps/personal/<name>/app`: the same Kustomization applies
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

Postgres or any service that needs a credential is deferred; apps hold none.

### Creating ghcr-apps-read

The one registry credential: a classic GitHub token with only `read:packages`,
created by the owner with a one-year expiry (set a calendar reminder a month
before). It can read every private package of the account. Never paste it into
chat, a log or Git. `scripts/validate-apps.sh` fails until
`app-platform/app/ghcr-apps-read.sops.yaml` exists, is encrypted and carries the
label `reconcile.fluxcd.io/watch: Enabled` (without it a rotated token reaches
the copies only at the ResourceSet's next interval of 60 minutes). Create it in
one pipeline from the repo root, in bash or zsh, with `GHCR_READ_TOKEN` (and
optionally `GHCR_READ_USER`, default `mihirsamdarshi`) exported. The pipeline
never writes the plaintext token to a file: `sops encrypt` reads it from the
pipe and only its output reaches the repo path. If a step fails, the file is
left empty, which the validator rejects (never redirect the plaintext into the
file first, and check the file holds `ENC[` before you `git add` it):

```sh
kubectl create secret docker-registry ghcr-apps-read --namespace flux-system --docker-server=ghcr.io --docker-username="${GHCR_READ_USER:-mihirsamdarshi}" --docker-password="${GHCR_READ_TOKEN:?set GHCR_READ_TOKEN}" --dry-run=client -o yaml | yq '.stringData[".dockerconfigjson"] = (.data[".dockerconfigjson"] | @base64d) | del(.data) | .metadata.labels["reconcile.fluxcd.io/watch"] = "Enabled"' | sops encrypt --filename-override kubernetes/apps/flux-system/app-platform/app/ghcr-apps-read.sops.yaml --input-type yaml --output-type yaml /dev/stdin > kubernetes/apps/flux-system/app-platform/app/ghcr-apps-read.sops.yaml
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
- Never give an app a Secret, and never set `netpol: false` without a stated
  reason. Never add a `world` entity or a bare `0.0.0.0/0` rule to a policy.
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

## Bundle apps (Quilt Planner, until it moves)

An app's CI publishes an image and a private OCI bundle that holds its
Kubernetes manifests. Flux pulls the bundle and applies it as a service account
that can only change objects in that namespace. `quilt-planner/` is the working
example. New apps use the platform above instead.

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

1. Add `- ./<app>` to `personal/kustomization.yaml`.
2. Create `personal/<app>/kustomization.yaml`:

    ```yaml
    apiVersion: kustomize.config.k8s.io/v1beta1
    kind: Kustomization
    namespace: <app>
    components:
        - ../../../components/personal-namespace
    resources:
        - ks.yaml
    ```

3. Create `personal/<app>/ks.yaml`:

    ```yaml
    apiVersion: kustomize.toolkit.fluxcd.io/v1
    kind: Kustomization
    metadata:
        name: <app>-bootstrap
    spec:
        interval: 1h
        path: ./kubernetes/apps/personal/<app>/app
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

4. Create `personal/<app>/app/kustomization.yaml`:

    ```yaml
    apiVersion: kustomize.config.k8s.io/v1beta1
    kind: Kustomization
    components:
        - ../../../../components/personal-app
    resources:
        - registry.sops.yaml
    ```

5. Create `personal/<app>/app/registry.sops.yaml` from a token that can read
   the bundle's package (`read:packages`). Keep the token in an environment
   variable. Never paste it into chat, logs or Git. Encrypt before you stage
   the file:

    ```sh
    kubectl create secret docker-registry <app>-registry --namespace <app> \
      --docker-server=ghcr.io --docker-username=<github-user> \
      --docker-password="$GHCR_READ_TOKEN" --dry-run=client -o yaml \
      > kubernetes/apps/personal/<app>/app/registry.sops.yaml \
      && sops encrypt --in-place kubernetes/apps/personal/<app>/app/registry.sops.yaml
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
namespace. Copy the Quilt version and change the names. Whether and how to
expose an app is the owner's decision, so confirm it first.

A bundle cannot create routes: the reconciler's Role has no rule for
HTTPRoutes, so a bundle that ships one fails to apply. Exposure is added in
this repo, with the folders below. Keep it that way, because the gateways
accept routes from every namespace and a route in an app's namespace can attach
to `envoy-internal` or `envoy-family` without any other change. Restricting
`envoy-family` to labelled namespaces is a possible follow-up.

- **Tailnet:** copy `quilt-planner/tailnet/` and the `quilt-planner-tailnet`
  block in `quilt-planner/ks.yaml`. In `ingress.yaml`, change `tls.hosts` (the
  Tailscale machine name) and the backend Service.
- **Family:** copy `quilt-planner/family/` and the `quilt-planner-family` block
  in `network/family-apps/ks.yaml`. It has to live there, because it reads
  `cluster-secrets` in the `network` namespace. Two things must hold: the
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
    path: ./kubernetes/apps/personal/<app>/backup
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

From `personal/<app>/backup/` the component paths are
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
      kubernetes/apps/personal/<app>/ks.yaml > /tmp/ks.yaml
    flux diff kustomization <app>-bootstrap -n <app> \
      --path ./kubernetes/apps/personal/<app>/app --kustomization-file /tmp/ks.yaml
    ```

- To remove an app, delete its folder and its line in
  `personal/kustomization.yaml`, then delete its OCIRepository and Kustomization
  by hand (`kubectl -n <app> delete kustomization,ocirepository <app>`). Both
  are `prune: disabled`, so Flux leaves them. The app's own objects, its PVC and
  the Namespace stay until you delete them too.
