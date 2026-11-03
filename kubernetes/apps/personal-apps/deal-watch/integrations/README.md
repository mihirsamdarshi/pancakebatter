# Deal Watch integrations

The integration worker for the Deal Watch dashboard. The code and its tests are
in `integrations/deal-watch/`. The dashboard itself is a platform app; see
`../kustomization.yaml` and the platform entry for `deal-watch`.

The worker runs outside the credential-free app platform, in its own Namespace
`deal-watch-integrations`. It mounts the Discord webhook and the watch policy
from the SOPS-encrypted `app/credentials.sops.yaml`, and pulls its image with
the SOPS-encrypted read-only GHCR credential in `app/registry.sops.yaml`. The
Flux Kustomization `deal-watch-integrations` lives in `flux-system` and reads
the domain substitution there. No copy of `cluster-secrets` is added to the
worker namespace.

The Flux dependency is the Git-defined `app-platform` Kustomization and the
gateway. Before every cycle, the worker requires a successful dashboard response
and the same policy identity as the dashboard. If either fails, it makes no
retailer or Discord request.

## Releases

- `app/deployment.yaml` pins the worker image by digest. The main workflow for
  `integrations/deal-watch/` publishes it.
- `checksum/runtime-config` is the sha256 of `app/credentials.sops.yaml`, so a
  Secret change restarts the worker.
- A change to the watch policy goes into the dashboard source and into
  `watch-policy.json` in the same release. Until both run, the worker reports a
  policy mismatch and pauses its checks.

No Service, route, PVC or API token is added for callers. The worker does not
buy anything.
