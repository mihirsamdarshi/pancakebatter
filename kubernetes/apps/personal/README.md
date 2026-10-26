# Personal apps

Apps the owner writes and ships from their own repositories, one namespace per
app. An app's CI publishes an image and a private OCI bundle that holds its
Kubernetes manifests. Flux pulls the bundle and applies it as a service account
that can only change objects in that namespace. This folder holds the wiring,
not the manifests. `quilt-planner/` is the working example.

## How it fits together

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

The Role covers Services, PVCs, ConfigMaps, Deployments and HTTPRoutes, plus
read access to ReplicaSets and Pods for the health check. It cannot read
Secrets, create Roles or touch anything outside the namespace. The bundle's
Kustomization has `deletionPolicy: Orphan`: deleting it leaves the app and its
data running.

## Add an app

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

## Storage

The app's PVC belongs to its bundle. For data that matters, use the shared
`local-retain` class (`storage/local-path-provisioner`): node-local, and a
deleted claim keeps the volume. `local-path` deletes the volume with the claim.
Also give that PVC the annotation `kustomize.toolkit.fluxcd.io/prune: disabled`,
as Quilt's `quilt-data` has. Quilt predates the shared class and has its own
`quilt-local-retain` in `quilt-planner/app/storage-class.yaml`; do not copy it.

## Reach it from the tailnet or from family

Both are separate Flux Kustomizations that apply a small folder into the app's
namespace. Copy the Quilt version and change the names. Whether and how to
expose an app is the owner's decision, so confirm it first.

Take care: the gateways accept routes from every namespace, and the
reconciler's Role can create HTTPRoutes. So an app's own bundle can attach a
route to `envoy-internal` or `envoy-family` without any change here. Add family
exposure deliberately, in this repo, with the `family/httproute.yaml` pattern
below, and read a bundle's HTTPRoutes before you trust it. Restricting
`envoy-family` to labelled namespaces is a possible follow-up.

- **Tailnet:** copy `quilt-planner/tailnet/` and the `quilt-planner-tailnet`
  block in `quilt-planner/ks.yaml`. In `ingress.yaml`, change `tls.hosts` (the
  Tailscale machine name) and the backend Service.
- **Family:** copy `quilt-planner/family/` and the `quilt-planner-family` block
  in `network/family-apps/ks.yaml`. It has to live there, because it reads
  `cluster-secrets` in the `network` namespace. Keep two rules: the route's only
  parent is `envoy-family` in `network`, with no `sectionName`, and its hostnames
  sit under `${SECRET_FAMILY_DOMAIN}`. Never attach it to `envoy-internal`. See
  `network/family-apps/README.md`, which also explains the transitional names
  Quilt's route still lists.

## Backups

Nightly restic backups of an app's volume use the `volsync` component
(`kubernetes/components/volsync`, added by the VolSync change, PR #729; it is
not available before that merges). An app opts in with a `backup/` folder
that includes the component, plus one more Flux Kustomization in its `ks.yaml`:

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
            VOLSYNC_SCHEDULE: "<cron, UTC; 15 minutes after the previous app>"
```

From `personal/<app>/backup/` the component path is
`../../../../components/volsync`. The component's README has the rest,
including restore.

## Rules that keep a move safe

- Never rename a Flux Kustomization or change its namespace. Flux sees a new
  object, and prunes the old one together with what it applied. Change only its
  `spec.path` when files move.
- Keep one namespace per app, and do not widen the reconciler's Role to
  cluster-wide kinds. That limit is the isolation.
- Do not remove `prune: disabled` from a Namespace, a StorageClass or a data
  PVC.
