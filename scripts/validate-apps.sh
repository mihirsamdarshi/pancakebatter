#!/usr/bin/env bash
# Validates the personal app platform: the entries under
# kubernetes/apps/flux-system/app-platform/apps, the two ResourceSets that
# render them, and everything those render.
#
#   validate-apps.sh [ROOT]        validate every entry under ROOT (default: repo root)
#   validate-apps.sh --entry FILE  validate one entry file (also used for the fixtures)
#   validate-apps.sh --self-test   run the fixtures: scripts/validate-apps/fixtures
#
# scripts/validate-kubernetes.sh calls it, so the Kubernetes workflow and
# `just template configure` run it too. A tree without the app platform is
# skipped. Environment: APPS_BASE_REF (a git ref such as origin/main) turns on
# the check that an existing entry keeps its name and namespace; the Kubernetes
# workflow sets it on pull requests.
#
# Why this exists: a ResourceSet applies none of its objects when one fails the
# API server's dry run, so one bad Kustomization would block every app's update.
# The render, `flux build ks` and kubeconform steps below are therefore
# mandatory, and fail closed (a missing tool or schema fails the run).
#
# Checks, in order (the numbers follow docs: app platform design 5.6):
#   0. the registry credential flux-system/ghcr-apps-read (SOPS file exists,
#      encrypted, labelled for the operator's watch). Fails first with a clear
#      message, because it is created by the owner, never by an agent;
#   1. the entry: only schema keys, names, parts, netpol/egress rules, env and
#      vars rules, retain-class storage, unique schedules and namespaces;
#   2. `flux-operator build rset` for both ResourceSets (the CLI only takes
#      Static providers, so type is rewritten and a fake digest injected);
#   3. the rendered Kustomization: Orphan, wait, SOPS, string-only substitution,
#      no name clash with a Kustomization in Git, no force annotation;
#   4. `flux build ks --dry-run | kubeconform`, restricted pod fields and the
#      route rules;
#   5. the network policy, compared field by field with the design;
#   6. no credentials: no Secret reference in any pod spec, no service-account
#      token, and gitleaks over the entries and every custom folder;
#   6a. custom `path` folders on their own: plain workload kinds only;
#   7. the pull Secret that `apps-pull` renders;
#   8. the Namespace folder under kubernetes/apps/personal, and renames;
#   9. the flux-operator CLI version equals the operator chart tag; the
#      PrometheusRule app-platform exists, names every entry's namespace and
#      passes promtool check and its unit tests.

set -euo pipefail

script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
script_dir="$(dirname "$script_path")"

platform_dir="kubernetes/apps/flux-system/app-platform"
apps_dir="$platform_dir/apps"
app_dir="$platform_dir/app"
rs_apps="$app_dir/resourceset.yaml"
rs_pull="$app_dir/resourceset-pull.yaml"
credential="$app_dir/ghcr-apps-read.sops.yaml"
retired_file="$platform_dir/retired.txt"
fixtures_dir="scripts/validate-apps/fixtures"
base_path="./kubernetes/components/app-platform/base"
# Not real: only so that the rendered hostnames can be checked.
fake_local="local.example.test"
fake_family="family.example.test"
fake_digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

# Same Kubernetes schemas as validate-kubernetes.sh, and no
# -ignore-missing-schemas: a CRD without a published schema fails the run.
kubeconform_args=(
    "-strict"
    "-summary"
    "-skip" "Secret"
    "-schema-location" "default"
    "-schema-location" "https://k8s-schemas.home-operations.com/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"
)

tmp=""
entry_label="validate-apps"

die() {
    echo "validate-apps: $*" >&2
    exit 1
}

fail() {
    echo "validate-apps: $entry_label: $*" >&2
    exit 1
}

require_tools() {
    local tool missing=()
    for tool in flux-operator flux kustomize kubeconform yq jq gitleaks promtool git; do
        command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
    done
    ((${#missing[@]} == 0)) || die "missing tools: ${missing[*]} (run via 'mise exec --' or 'mise install')"
}

setup_cache() {
    local cache="${KUBECONFORM_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/kubeconform}"
    mkdir -p "$cache"
    kubeconform_args+=("-cache" "$cache")
}

# kubeconform on stdin. See validate-kubernetes.sh: ${VAR:=default} becomes its
# default and any other leftover ${VAR...} a DNS-label-safe stand-in.
conform() {
    sed -E \
        -e 's/\$\{[A-Za-z_][A-Za-z0-9_]*:[-=]([^}]*)\}/\1/g' \
        -e 's/\$\{[A-Za-z_][^}]*\}/placeholder/g' \
        | kubeconform "${kubeconform_args[@]}"
}

# --- Facts from Git ---------------------------------------------------------

# Writes, under $tmp: the StorageClasses with reclaimPolicy Retain, the names of
# Secrets declared in Git, the names of Flux Kustomizations declared in Git and
# the backup schedules they set.
collect_git_facts() {
    local f
    find kubernetes -type f -name '*.yaml' ! -name kustomization.yaml -print0 | sort -z >"$tmp/all-manifests"
    : >"$tmp/retain.list" && : >"$tmp/secrets.list" && : >"$tmp/ks.names"
    : >"$tmp/git.volsync" && : >"$tmp/git.sqlite"
    while IFS= read -r -d '' f; do
        yq -N 'select(.kind == "StorageClass" and .reclaimPolicy == "Retain") | .metadata.name' "$f" >>"$tmp/retain.list"
        yq -N 'select(.kind == "Secret") | .metadata.name' "$f" >>"$tmp/secrets.list"
        yq -N 'select(.apiVersion == "kustomize.toolkit.fluxcd.io/*" and .kind == "Kustomization") | .metadata.name' "$f" >>"$tmp/ks.names"
        yq -N 'select(.apiVersion == "kustomize.toolkit.fluxcd.io/*" and .kind == "Kustomization") | .spec.postBuild.substitute.VOLSYNC_SCHEDULE // ""' "$f" >>"$tmp/git.volsync"
        yq -N 'select(.apiVersion == "kustomize.toolkit.fluxcd.io/*" and .kind == "Kustomization") | .spec.postBuild.substitute.SQLITE_SCHEDULE // ""' "$f" >>"$tmp/git.sqlite"
    done <"$tmp/all-manifests"
    grep -qxF local-retain "$tmp/retain.list" \
        || die "the default StorageClass local-retain is not a Retain class in Git (components/app-platform/base/pvc.yaml relies on it)"
}

# --- 0, 7. The pull credential ----------------------------------------------

check_credential() {
    local f
    [[ -f "$credential" ]] || die "$credential is missing: create it before merging. It is the registry token (classic read:packages) every app Kustomization and image pull uses, and only the owner creates it. See 'Creating ghcr-apps-read' in kubernetes/apps/personal/README.md"
    [[ "$(yq '.kind' "$credential")" == "Secret" \
        && "$(yq '.metadata.name' "$credential")" == "ghcr-apps-read" \
        && "$(yq '.metadata.namespace' "$credential")" == "flux-system" \
        && "$(yq '.type' "$credential")" == "kubernetes.io/dockerconfigjson" ]] \
        || die "$credential must be a kubernetes.io/dockerconfigjson Secret named ghcr-apps-read in flux-system"
    [[ "$(yq '.metadata.labels["reconcile.fluxcd.io/watch"]' "$credential")" == "Enabled" ]] \
        || die "$credential needs the label reconcile.fluxcd.io/watch: Enabled in metadata (without it a rotated token reaches the copies only at the ResourceSet's next interval)"
    # stringData, like every other SOPS Secret here: `flux build ks` cannot mask
    # an encrypted value under `data` (it tries to base64-decode ENC[...]).
    [[ "$(yq '.stringData[".dockerconfigjson"] | test("^ENC\\[")' "$credential")" == "true" ]] \
        || die "$credential: stringData[.dockerconfigjson] is missing or not SOPS-encrypted (use stringData, not data: flux build cannot mask an encrypted data value)"
    [[ "$(yq '.data // {} | length' "$credential")" == "0" ]] \
        || die "$credential has a data field; use stringData (flux build ks cannot mask an encrypted data value)"
    yq -e '.sops' "$credential" >/dev/null 2>&1 || die "$credential has no sops metadata (not encrypted)"
    yq -e '.resources[] | select(. == "./ghcr-apps-read.sops.yaml")' "$app_dir/kustomization.yaml" >/dev/null 2>&1 \
        || die "$app_dir/kustomization.yaml does not list ./ghcr-apps-read.sops.yaml"

    # Every SOPS file of the platform must really be encrypted.
    for f in "$app_dir"/*.sops.yaml; do
        yq -e '.sops' "$f" >/dev/null 2>&1 || die "$f has no sops metadata (not encrypted)"
        [[ "$(yq '[(.data // {}) + (.stringData // {}) | to_entries[] | .value | test("^ENC\\[") | not] | any' "$f")" == "false" ]] \
            || die "$f has a plaintext value under data or stringData"
    done
    echo "--- pull credential: $credential is encrypted and labelled"
}

# --- 9. Tooling and the two templates ---------------------------------------

check_tooling() {
    local cli chart pin
    cli="$(flux-operator version --client | awk '{print $2}')"
    chart="$(yq '.spec.ref.tag' kubernetes/apps/flux-system/flux-operator/app/ocirepository.yaml)"
    [[ -n "$cli" && "$cli" == "$chart" ]] \
        || die "flux-operator CLI $cli does not equal the operator chart tag $chart (kubernetes/apps/flux-system/flux-operator/app/ocirepository.yaml)"
    pin="$(sed -nE 's/^flux-operator = "([^"]+)".*/\1/p' .mise/config.toml)"
    [[ "$pin" == "$chart" ]] \
        || die ".mise/config.toml pins flux-operator '$pin', the operator chart tag is $chart"
    echo "--- tooling: flux-operator CLI $cli equals the operator chart tag"
}

# The two ResourceSets must agree on the `parts` default and the namespace
# expression, or `apps-pull` copies a Secret into a namespace `apps` does not
# use (or none).
# shellcheck disable=SC2016  # Go-template variables, not shell ones
check_templates_in_sync() {
    local a b
    a="$(grep -F '$parts := list' "$rs_apps" | sed -E 's/^[[:space:]]+//')"
    b="$(grep -F '$parts := list' "$rs_pull" | sed -E 's/^[[:space:]]+//')"
    [[ -n "$a" && "$a" == "$b" ]] || die "the \$parts default differs between $rs_apps and $rs_pull"
    a="$(grep -F 'if hasKey inputs "parts"' "$rs_apps" | sed -E 's/^[[:space:]]+//')"
    b="$(grep -F 'if hasKey inputs "parts"' "$rs_pull" | sed -E 's/^[[:space:]]+//')"
    [[ -n "$a" && "$a" == "$b" ]] || die "the parts override differs between $rs_apps and $rs_pull"
    if ! { grep -qF '$name := inputs.name' "$rs_apps" \
        && grep -qF '$ns := get inputs "namespace" | default $name' "$rs_apps" \
        && grep -qF 'get inputs "namespace" | default inputs.name' "$rs_pull"; }; then
        die "the namespace expression differs between $rs_apps and $rs_pull"
    fi
    echo "--- templates: parts default and namespace expression agree"
}

# --- 1. The entry ------------------------------------------------------------

read -r -d '' entry_jq <<'JQ' || true
def isstr: type == "string";
def secretish: test("TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|KEY|CREDENTIAL|AUTH|PRIVATE|CERT"; "i");
def cron: isstr and test("^[^ ]+( [^ ]+){4}$");
def lbl: isstr and test("^[a-z0-9]([-a-z0-9]*[a-z0-9])?$");
def qty: ((isstr) or (type == "number")) and (tostring | test("^[0-9]+(\\.[0-9]+)?(m|k|M|G|T|Ki|Mi|Gi|Ti)?$"));
. as $e
| (if ($e.spec.defaultValues | type) == "object" then $e.spec.defaultValues else {} end) as $d
| (if ($d.vars | type) == "object" then $d.vars else {} end) as $v
| (if ($d.env | type) == "object" then $d.env else {} end) as $env
| (if ($d.name | isstr) then $d.name else "" end) as $name
| (if ($d.namespace | isstr) then $d.namespace else $name end) as $ns
| (if ($d.parts | type) == "array" then $d.parts else ["pullsecret", "internal-route", "backup"] end) as $parts
| ["pullsecret", "internal-route", "family-route", "family-route-legacy", "backup", "backup-sqlite"] as $known
| ["name", "namespace", "parts", "netpol", "netpolReason", "egress", "pin", "env", "path", "vars"] as $topkeys
| ["CLAIM", "STORAGE", "STORAGE_CLASS", "HEALTH_PATH", "APP_UID", "APP_GID", "DATA_PATH", "CPU", "MEMORY", "MEMORY_LIMIT", "IMAGE", "PULL_SECRET", "HOST", "FAMILY_HOST", "SQLITE_DBS", "VOLSYNC_SCHEDULE", "SQLITE_SCHEDULE"] as $varkeys
| ["APP", "IMAGE_DIGEST", "APP_NAMESPACE", "VOLSYNC_NAMESPACE", "VOLSYNC_CLAIM"] as $reserved
| [
    (if $e.apiVersion != "fluxcd.controlplane.io/v1" or $e.kind != "ResourceSetInputProvider" then "must be a fluxcd.controlplane.io/v1 ResourceSetInputProvider" else empty end),
    (if ($e.spec.defaultValues | type) != "object" then "spec.defaultValues must be a map" else empty end),
    (if $e.metadata.namespace != "flux-system" then "metadata.namespace must be flux-system" else empty end),
    (if ($e.metadata.labels["platform/apps"] // "") != "true" then "label platform/apps: \"true\" is required (both ResourceSets select on it)" else empty end),
    (if ($d.name | isstr | not) then "defaultValues.name is required"
     elif ($name | test("^[a-z][a-z0-9-]*$") | not) then "name \($name) must match ^[a-z][a-z0-9-]*$ (a numeric name would become an integer after substitution)"
     else empty end),
    (if $name != $stem then "file name \($stem).yaml must equal defaultValues.name \($name)" else empty end),
    (if $e.metadata.name != "app-" + $name then "metadata.name must be app-\($name), not \($e.metadata.name)" else empty end),
    ($e | keys - ["apiVersion", "kind", "metadata", "spec"] | .[] | "unknown top-level key \(.)"),
    (($e.metadata // {}) | keys - ["name", "namespace", "labels", "annotations"] | .[] | "unknown metadata key \(.)"),
    (($e.metadata.labels // {}) | keys - ["platform/apps"] | .[] | "unknown label \(.) (only platform/apps)"),
    (($e.metadata.annotations // {}) | keys - ["fluxcd.controlplane.io/reconcileEvery"] | .[] | "unknown annotation \(.) (only fluxcd.controlplane.io/reconcileEvery)"),
    (($e.spec // {}) | keys - ["type", "url", "secretRef", "filter", "defaultValues"] | .[] | "unknown spec key \(.) (allowed: type, url, secretRef, filter, defaultValues)"),
    (($e.spec.secretRef // {}) | keys - ["name"] | .[] | "unknown spec.secretRef key \(.)"),
    (($e.spec.filter // {}) | keys - ["includeTag", "limit"] | .[] | "unknown spec.filter key \(.) (allowed: includeTag, limit)"),
    (if $e.spec.type != "OCIArtifactTag" then "spec.type must be OCIArtifactTag" else empty end),
    (if (($e.spec.url // "") | startswith("oci://ghcr.io/") | not) then "spec.url must be an oci://ghcr.io/ URL" else empty end),
    (if $e.spec.secretRef.name != "ghcr-apps-read" then "spec.secretRef.name must be ghcr-apps-read" else empty end),
    (if ($e.spec.filter.includeTag | isstr | not) or $e.spec.filter.includeTag == "" then "spec.filter.includeTag is required (the tag to follow, ^main$)" else empty end),
    (if $e.spec.filter.limit != 1 then "spec.filter.limit must be 1" else empty end),
    (if ($e.metadata.annotations["fluxcd.controlplane.io/reconcileEvery"] // "") == "" then "annotation fluxcd.controlplane.io/reconcileEvery is required (2m)" else empty end),
    (($d | keys) - $topkeys | .[] | "unknown setting \(.) (allowed: \($topkeys | join(", ")))"),
    (if ($d | has("namespace")) and ($d.namespace | lbl | not) then "namespace \($d.namespace) must be a lowercase DNS label" else empty end),
    # parts
    (if ($d | has("parts")) and ($d.parts | type) != "array" then "parts must be a list" else empty end),
    ($parts | map(select(isstr | not)) | if length > 0 then "parts must be strings" else empty end),
    ($parts[] | select(isstr) | select(IN($known[]) | not) | if . == "namespace" then "`namespace` is not a part and is rejected (it is a setting)" else "unknown part \(.)" end),
    (if ($parts | length) != ($parts | unique | length) then "duplicate parts" else empty end),
    (if ($parts | index("family-route-legacy")) != null and (($parts | index("family-route")) == null or ($parts | index("family-route")) > ($parts | index("family-route-legacy"))) then "family-route-legacy patches the route of family-route, so family-route must come before it in parts" else empty end),
    (if ($parts | index("family-route")) != null and (($v.FAMILY_HOST | lbl) | not) then "family-route needs vars.FAMILY_HOST (a DNS label)" else empty end),
    # netpol and egress
    (if ($d | has("netpol")) and ($d.netpol | type) != "boolean" then "netpol must be true or false" else empty end),
    (if $d.netpol == false and (($d.netpolReason | isstr | not) or ($d.netpolReason | gsub("\\s"; "") == "")) then "netpol: false needs a non-empty netpolReason" else empty end),
    (if ($d | has("egress")) and (["none", "internet"] | index($d.egress) == null) then "egress must be none or internet" else empty end),
    (if $d.netpol == false and $d.egress == "internet" then "egress: internet has no meaning with netpol: false" else empty end),
    # pin
    (if ($d | has("pin")) and (($d.pin | isstr | not) or ($d.pin | test("^sha256:[0-9a-f]{64}$") | not)) then "pin must be sha256:<64 hex digits>" else empty end),
    # env
    (if ($d | has("env")) and ($d.env | type) != "object" then "env must be a map of plain strings" else empty end),
    ($env | to_entries[]
      | (if (.key | test("^[A-Z][A-Z0-9_]*$") | not) then "env key \(.key) must be uppercase letters, digits and _" else empty end),
        (if (.key | IN("N", "Y", "ON", "OFF")) then "env key \(.key) is a YAML boolean" else empty end),
        (if (.key | secretish) then "env key \(.key) looks like a credential name (apps hold no credentials)" else empty end),
        (if (.value | isstr | not) then "env \(.key): values are plain strings (no valueFrom, no maps, no numbers)"
         elif (.value | gsub("\\$\\$"; "") | contains("$")) then "env \(.key): a literal $ must be written $$"
         else empty end)),
    # vars
    (if ($d | has("vars")) and ($d.vars | type) != "object" then "vars must be a map" else empty end),
    ($v | to_entries[]
      | (if (.key | IN($reserved[])) then "vars.\(.key) is a reserved name"
         elif (.key | IN($varkeys[]) | not) then "unknown vars key \(.key) (allowed: \($varkeys | join(", ")))"
         else empty end),
        (if .key != "PULL_SECRET" and (.key | secretish) then "vars.\(.key) looks like a credential name (apps hold no credentials)" else empty end),
        (if ((.value | isstr) or (.value | type) == "number") | not then "vars.\(.key) must be a string or a number" else empty end)),
    (("APP_UID", "APP_GID") as $k
      | if ($v | has($k)) then ($v[$k] | tostring) as $s
          | (if ($s | test("^[0-9]+$") | not) or ($s | test("^0+$")) then "vars.\($k) must be a positive integer (0 is rejected)" else empty end)
        else empty end),
    (if ($v | has("STORAGE_CLASS")) and (($v.STORAGE_CLASS | tostring) | IN($retain[]) | not) then "vars.STORAGE_CLASS \($v.STORAGE_CLASS) is not a StorageClass with reclaimPolicy Retain in Git (\($retain | join(", ")))" else empty end),
    (($v.PULL_SECRET // "apps-ghcr") as $ps
      | if $ps != "apps-ghcr" and ($ps | tostring | IN($pullsecrets[]) | not) then "vars.PULL_SECRET \($ps) is not a Secret declared in Git" else empty end),
    (("CPU", "MEMORY", "MEMORY_LIMIT", "STORAGE") as $k
      | if ($v | has($k)) and ($v[$k] | qty | not) then "vars.\($k) is not a Kubernetes quantity" else empty end),
    (if ($v | has("HEALTH_PATH")) and (($v.HEALTH_PATH | isstr | not) or ($v.HEALTH_PATH | startswith("/") | not)) then "vars.HEALTH_PATH must start with /" else empty end),
    (if ($v | has("DATA_PATH")) and (($v.DATA_PATH | isstr | not) or ($v.DATA_PATH | test("^/[^ ]*[^/ ]$") | not)) then "vars.DATA_PATH must be an absolute path without a trailing slash" else empty end),
    (("HOST", "FAMILY_HOST") as $k
      | if ($v | has($k)) and ($v[$k] | lbl | not) then "vars.\($k) must be a lowercase DNS label" else empty end),
    (if ($v | has("IMAGE")) and (($v.IMAGE | isstr | not) or ($v.IMAGE | test("^[a-z0-9][a-z0-9./_:-]*$") | not)) then "vars.IMAGE is not an image name" else empty end),
    # backup
    (if ($parts | index("backup")) != null and (($v.VOLSYNC_SCHEDULE | cron) | not) then "backup needs vars.VOLSYNC_SCHEDULE, an explicit UTC cron string" else empty end),
    (if ($parts | index("backup-sqlite")) != null then
       (if ($v.SQLITE_SCHEDULE | cron | not) then "backup-sqlite needs vars.SQLITE_SCHEDULE, an explicit UTC cron string" else empty end),
       (if ($v.SQLITE_DBS | isstr | not) or $v.SQLITE_DBS == "" or ($v.SQLITE_DBS | test("(^| )/|\\.\\.")) then "backup-sqlite needs vars.SQLITE_DBS: space-separated paths relative to the volume, without .." else empty end)
     else empty end),
    # path
    (if ($d | has("path")) then
       (if ($d.path | isstr | not) then "path must be a string"
        elif ($d.path | endswith("/")) then "path must not end with a slash"
        elif ($d.path | IN($base, "./kubernetes/apps/personal/\($ns)/app", "./kubernetes/apps/personal/\($name)/app")) then empty
        elif $fx and ($d.path | test("^\\./scripts/validate-apps/fixtures/custom/[a-z0-9-]+$")) then empty
        else "path must be the default base or ./kubernetes/apps/personal/\($ns)/app" end)
     else empty end)
  ]
| .[]
JQ

# --- 4-6. Rendered output ----------------------------------------------------

# Pod specs of a built manifest stream (slurped). Checks the restricted fields,
# the read-only root filesystem, no service-account token, no Secret reference
# and, when $ns is not empty, the namespace.
read -r -d '' pods_jq <<'JQ' || true
def containers: ((.initContainers // []) + (.containers // []) + (.ephemeralContainers // []));
def pods:
  .[] | select(type == "object" and .kind != null)
  | if .kind == "Pod" then {kind: .kind, name: .metadata.name, ns: .metadata.namespace, s: .spec}
    elif (.kind | IN("Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job")) then {kind: .kind, name: .metadata.name, ns: .metadata.namespace, s: .spec.template.spec}
    elif .kind == "CronJob" then {kind: .kind, name: .metadata.name, ns: .metadata.namespace, s: .spec.jobTemplate.spec.template.spec}
    else empty end;
[
  pods
  | . as $p | .s as $s | "\($p.kind)/\($p.name)" as $id
  | (
      (if $ns != "" and $p.ns != $ns then "\($id): namespace \($p.ns) is not \($ns)" else empty end),
      (if $s.automountServiceAccountToken != false then "\($id): automountServiceAccountToken must be false on every pod" else empty end),
      ($s | [.. | objects | keys[] | select(IN("valueFrom", "secretKeyRef", "secretRef"))] | unique | .[] | "\($id): \(.) is forbidden (apps receive no Secrets, env values are plain)"),
      (($s.volumes // [])[] | select(has("secret")) | "\($id): secret volume \(.name) is forbidden"),
      (($s.volumes // [])[] | select((.projected.sources // []) | any(has("secret") or has("serviceAccountToken"))) | "\($id): projected volume \(.name) with a Secret or serviceAccountToken source is forbidden"),
      (($s.volumes // [])[] | (keys - ["name", "persistentVolumeClaim", "emptyDir", "configMap"]) as $bad | select(($bad | length) > 0) | "\($id): volume \(.name) of type \($bad | join(",")) is not allowed (persistentVolumeClaim, emptyDir and configMap only)"),
      (if ($s.serviceAccountName != null or $s.serviceAccount != null) then "\($id): serviceAccountName is forbidden (no ServiceAccount; apps use none)" else empty end),
      (if $s.securityContext.runAsUser == 0 then "\($id): runAsUser 0 is forbidden" else empty end),
      (($s.imagePullSecrets // [])[] | .name | select(IN($pull[]) | not) | "\($id): imagePullSecret \(.) is not the platform's"),
      (if ($s.hostNetwork == true or $s.hostPID == true or $s.hostIPC == true) then "\($id): host namespaces are forbidden" else empty end),
      (if ($s.securityContext.runAsNonRoot == true) or ($s | containers | all(.securityContext.runAsNonRoot == true)) then empty else "\($id): runAsNonRoot must be true" end),
      (if ($s.securityContext.seccompProfile.type == "RuntimeDefault") or ($s | containers | all(.securityContext.seccompProfile.type == "RuntimeDefault")) then empty else "\($id): seccompProfile RuntimeDefault is required" end),
      ($s | containers[] | . as $c
        | (if $c.securityContext.allowPrivilegeEscalation != false then "\($id)/\($c.name): allowPrivilegeEscalation must be false" else empty end),
          (if (($c.securityContext.capabilities.drop // []) | index("ALL")) == null then "\($id)/\($c.name): capabilities must drop ALL" else empty end),
          (if $c.securityContext.privileged == true then "\($id)/\($c.name): privileged is forbidden" else empty end),
          (if $c.securityContext.runAsUser == 0 then "\($id)/\($c.name): runAsUser 0 is forbidden" else empty end),
          (($c.ports // [])[] | select(has("hostPort")) | "\($id)/\($c.name): hostPort is forbidden"),
          (if ((($c.securityContext.capabilities.add // []) - ["NET_BIND_SERVICE"]) | length) > 0 then "\($id)/\($c.name): capabilities.add beyond NET_BIND_SERVICE is forbidden" else empty end),
          (if $c.securityContext.readOnlyRootFilesystem != true then "\($id)/\($c.name): readOnlyRootFilesystem must be true (writes go to the data volume and /tmp)" else empty end))
    )
]
| .[]
JQ

# The network policy and the routes of one entry, compared with the design.
read -r -d '' netpol_jq <<'JQ' || true
def port3000: [{ports: [{port: "3000", protocol: "TCP"}]}];
def own: {fromEndpoints: [{matchLabels: {"io.kubernetes.pod.namespace": $ns}}]};
def ownTo: {toEndpoints: [{matchLabels: {"io.kubernetes.pod.namespace": $ns}}]};
def expected_ingress: [
  own,
  {fromEndpoints: [{matchLabels: {"io.kubernetes.pod.namespace": "network", "gateway.envoyproxy.io/owning-gateway-namespace": "network"},
                    matchExpressions: [{key: "gateway.envoyproxy.io/owning-gateway-name", operator: "In", values: ["envoy-internal", "envoy-family"]}]}],
   toPorts: port3000},
  {fromEntities: ["host"], toPorts: port3000}
];
def expected_egress: [
  ownTo,
  {toEndpoints: [{matchLabels: {"io.kubernetes.pod.namespace": "kube-system", "k8s-app": "kube-dns"}}],
   toPorts: [{ports: [{port: "53", protocol: "UDP"}, {port: "53", protocol: "TCP"}]}]}
];
def internet_except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "192.0.0.0/24", "198.18.0.0/15", "224.0.0.0/3"];
. as $all
| [.[] | select(type == "object" and (.kind | IN("CiliumNetworkPolicy", "CiliumClusterwideNetworkPolicy", "NetworkPolicy")))] as $pols
| [.[] | select(type == "object" and .kind == "HTTPRoute")] as $routes
| [.[] | select(type == "object" and .kind == "BackendTrafficPolicy")] as $btps
| [
    # Network policy.
    (if $netpol | not then
       (if ($pols | length) > 0 then "netpol: false must render no network policy" else empty end)
     elif ($pols | length) != 1 then "expected exactly one CiliumNetworkPolicy, found \($pols | length)"
     else
       $pols[0] as $p
       | (if $p.kind != "CiliumNetworkPolicy" or $p.metadata.name != $name or $p.metadata.namespace != $ns then "the policy must be a CiliumNetworkPolicy named \($name) in \($ns)" else empty end),
         (if $p.spec.endpointSelector != {} then "endpointSelector must be exactly {} (namespace-wide)" else empty end),
         (if ($p.spec | keys) != ["egress", "endpointSelector", "ingress"] then "the policy spec has keys other than endpointSelector, ingress and egress" else empty end),
         (if $p.spec.ingress != expected_ingress then "ingress is not: own namespace, the two gateways on 3000/TCP, host on 3000/TCP" else empty end),
         (if $egress == "internet" then
            (if ($p.spec.egress | length) != 3 or $p.spec.egress[0:2] != expected_egress then "egress must be the own-namespace rule and kube-dns on 53, then the internet rule"
             else
               $p.spec.egress[2] as $r
               | (if ($r | keys) != ["toCIDRSet"] or ($r.toCIDRSet | length) != 1 or ($r.toCIDRSet[0] | keys) != ["cidr", "except"] or $r.toCIDRSet[0].cidr != "0.0.0.0/0" then "the internet rule must be a single toCIDRSet of 0.0.0.0/0 with an except list" else empty end),
                 (if ($r.toCIDRSet[0].except | sort) != (internet_except | sort) then "the except list must be exactly \(internet_except | join(", "))" else empty end)
             end)
          elif $p.spec.egress != expected_egress then "egress is not: own namespace, kube-dns on 53 UDP and TCP"
          else empty end),
         (if ($p | tojson | test("\"world\"|kube-apiserver|toEntities|toFQDNs")) then "the policy has a world, kube-apiserver, toEntities or toFQDNs rule" else empty end)
     end),
    # Routes: the internal route is default, the family route only on request.
    ($routes[] | .metadata.name as $rn
      | (if .metadata.namespace != $ns then "HTTPRoute \($rn) is not in \($ns)" else empty end),
        (if ($rn != "\($name)-internal" and $rn != "\($name)-family") then "unexpected HTTPRoute \($rn)" else empty end),
        (if ([.spec.rules[] | .name] != ["reads", "writes"]) then "HTTPRoute \($rn): rules must be reads and writes" else empty end),
        (if (.spec.rules[0].matches != [{method: "GET"}, {method: "HEAD"}]) or (.spec.rules[1] | has("matches")) then "HTTPRoute \($rn): reads must match GET and HEAD, writes must be the catch-all" else empty end),
        (if ([.spec.rules[].backendRefs[]] | all(. == {name: $name, port: 80})) | not then "HTTPRoute \($rn): backendRefs must be Service \($name) port 80" else empty end)),
    (if ($parts | index("internal-route")) != null then
       ($routes | map(select(.metadata.name == "\($name)-internal")) | if length != 1 then "internal-route renders no HTTPRoute \($name)-internal" else
          .[0] as $r
          | (if $r.spec.parentRefs != [{name: "envoy-internal", namespace: "network", sectionName: "https"}] then "the internal route must have the single parent envoy-internal/network section https" else empty end),
            (if $r.spec.hostnames != ["\($host).\($local)"] then "the internal route host must be \($host).<local zone>, not \($r.spec.hostnames | join(","))" else empty end)
        end)
     elif ($routes | any(.metadata.name == "\($name)-internal")) then "an internal route without the part" else empty end),
    (if ($parts | index("family-route")) != null then
       ($routes | map(select(.metadata.name == "\($name)-family")) | if length != 1 then "family-route renders no HTTPRoute \($name)-family" else
          .[0] as $r
          | (if $r.spec.parentRefs != [{name: "envoy-family", namespace: "network"}] then "the family route must have the single parent envoy-family/network with no sectionName" else empty end),
            (if $r.spec.hostnames != (["\($famhost).\($family)"] + (if ($parts | index("family-route-legacy")) != null then ["\($famhost).family.\($local)"] else [] end)) then "the family route hostnames must be \($famhost).<family zone>, plus \($famhost).family.<local zone> with family-route-legacy; got \($r.spec.hostnames | join(","))" else empty end)
        end)
     elif ($routes | any(.metadata.name == "\($name)-family")) then "a family route without the part" else empty end),
    ($routes[] | .metadata.name as $rn | ($btps | map(select(.metadata.name == "\($rn)-writes"))) as $b
      | if ($b | length) != 1 then "HTTPRoute \($rn) has no BackendTrafficPolicy \($rn)-writes"
        elif $b[0].spec.retry.numRetries != 0 or $b[0].spec.mergeType != "StrategicMerge"
             or $b[0].spec.targetRefs != [{group: "gateway.networking.k8s.io", kind: "HTTPRoute", name: $rn, sectionName: "writes"}]
        then "BackendTrafficPolicy \($rn)-writes must target rule writes with numRetries 0 and mergeType StrategicMerge"
        else empty end)
  ]
| .[]
JQ

# Kinds a custom `path` folder may hold (5.5).
custom_kinds='["Deployment","StatefulSet","Job","CronJob","Service","ConfigMap","PersistentVolumeClaim"]'

# Validates the custom folder on its own: the allowlist of kinds, then the
# credential rules on its output.
check_custom_path() {
    local dir="$1" kinds
    [[ -f "$dir/kustomization.yaml" ]] || fail "custom path $dir has no kustomization.yaml"
    [[ "$(yq '.secretGenerator // [] | length' "$dir/kustomization.yaml")" == "0" ]] \
        || fail "custom path $dir uses secretGenerator (apps hold no credentials)"
    kustomize build "$dir" --load-restrictor=LoadRestrictionsNone >"$tmp/custom.yaml" \
        || fail "custom path $dir does not build"
    kinds="$(yq -o=json -N '.' "$tmp/custom.yaml" | jq -s -r --argjson ok "$custom_kinds" \
        '[.[] | select(type == "object") | .kind | select(IN($ok[]) | not)] | unique | join(", ")')"
    [[ -z "$kinds" ]] || fail "custom path $dir holds kinds that are not allowed: $kinds (allowed: Deployment, StatefulSet, Job, CronJob, Service, ConfigMap, PersistentVolumeClaim)"
    kinds="$(yq -o=json -N '.' "$tmp/custom.yaml" | jq -s -r '[.[] | select(type == "object" and .kind == "Service" and (((.spec.type // "ClusterIP") != "ClusterIP") or (.spec | has("externalIPs") or has("loadBalancerIP")))) | .metadata.name] | join(", ")')"
    [[ -z "$kinds" ]] || fail "custom path $dir: Service $kinds must be a plain ClusterIP Service (no NodePort, LoadBalancer, ExternalName or externalIPs)"
    yq -o=json -N '.' "$tmp/custom.yaml" | jq -s -r --arg ns "" --argjson pull '["apps-ghcr"]' "$pods_jq" >"$tmp/custom.errs"
    [[ ! -s "$tmp/custom.errs" ]] || fail "custom path $dir: $(tr '\n' ';' <"$tmp/custom.errs")"
    echo "    custom path $dir: plain workload kinds, no credentials"
}

validate_entry() {
    local file="$1" stem fx=false errs name ns path parts_json pull_json host famhost netpol egress
    local sub_ok count secret_pull n nsdir
    stem="$(basename "$file" .yaml)"
    entry_label="$stem"
    case "$file" in "$fixtures_dir"/*) fx=true ;; esac
    echo "--- entry $file"

    [[ "$(yq ea '[.] | length' "$file")" == "1" ]] || fail "$file must hold exactly one document"

    # 1. The entry's own rules.
    yq -o=json -N '.' "$file" >"$tmp/entry.json"
    errs="$(jq -r --arg stem "$stem" --argjson fx "$fx" --arg base "$base_path" \
        --argjson retain "$(jq -R . "$tmp/retain.list" | jq -s .)" \
        --argjson pullsecrets "$(jq -R . "$tmp/secrets.list" | jq -s .)" \
        "$entry_jq" "$tmp/entry.json")"
    [[ -z "$errs" ]] || fail "$(printf '%s\n' "$errs" | sed '2,$s/^/    /')"

    name="$(yq '.spec.defaultValues.name' "$file")"
    ns="$(yq '.spec.defaultValues.namespace // .spec.defaultValues.name' "$file")"
    path="$(yq '.spec.defaultValues.path // ""' "$file")"
    parts_json="$(yq -o=json -I=0 '.spec.defaultValues.parts // ["pullsecret","internal-route","backup"]' "$file")"
    host="$(yq '.spec.defaultValues.vars.HOST // .spec.defaultValues.name' "$file")"
    famhost="$(yq '.spec.defaultValues.vars.FAMILY_HOST // ""' "$file")"
    # Not `// true`: the alternative operator would turn false into true.
    netpol="$(yq '.spec.defaultValues.netpol' "$file")"
    if [[ "$netpol" == "null" ]]; then netpol=true; fi
    egress="$(yq '.spec.defaultValues.egress // "none"' "$file")"
    pull_json="$(yq -o=json -I=0 '["apps-ghcr", (.spec.defaultValues.vars.PULL_SECRET // "apps-ghcr")]' "$file")"

    if [[ "$netpol" == "false" ]]; then
        echo "    NETWORK POLICY OFF for $name: $(yq '.spec.defaultValues.netpolReason' "$file")"
    fi

    # 8. The Namespace folder (Git-defined, same PR as the entry). The fixtures
    # use the folder of quilt-planner, which always exists.
    nsdir="kubernetes/apps/personal/$ns"
    [[ -f "$nsdir/kustomization.yaml" ]] \
        || fail "the Namespace folder $nsdir/kustomization.yaml is missing; add it (and its line in kubernetes/apps/personal/kustomization.yaml) in the same PR"
    [[ "$(yq '.namespace' "$nsdir/kustomization.yaml")" == "$ns" ]] \
        || fail "$nsdir/kustomization.yaml: namespace must be $ns"
    yq -e '.components[] | select(. == "../../../components/personal-namespace")' "$nsdir/kustomization.yaml" >/dev/null 2>&1 \
        || fail "$nsdir/kustomization.yaml must use ../../../components/personal-namespace"
    yq -e ".resources[] | select(. == \"./$ns\")" kubernetes/apps/personal/kustomization.yaml >/dev/null 2>&1 \
        || fail "kubernetes/apps/personal/kustomization.yaml does not list ./$ns"

    # 6a. A custom folder, on its own.
    [[ -z "$path" || "$path" == "$base_path" ]] || check_custom_path "${path#./}"

    # 2. Render. The CLI only takes Static providers.
    yq ".spec.type = \"Static\" | del(.spec.url) | del(.spec.secretRef) | del(.spec.filter) | .spec.defaultValues.digest = \"$fake_digest\"" "$file" >"$tmp/static.yaml"
    flux-operator build rset -f "$rs_apps" --inputs-from-provider "$tmp/static.yaml" >"$tmp/rset-apps.yaml" 2>"$tmp/rset.err" \
        || fail "flux-operator build rset (apps) failed: $(cat "$tmp/rset.err")"
    count="$(yq -N 'select(.kind == "Kustomization") | .metadata.name' "$tmp/rset-apps.yaml" | grep -c . || true)"
    [[ "$count" == "1" ]] || fail "the apps ResourceSet rendered $count Kustomizations, expected 1"
    yq -N 'select(.kind == "Kustomization")' "$tmp/rset-apps.yaml" >"$tmp/ks.yaml"

    # 3. Assertions on the rendered Kustomization.
    [[ "$(yq '.metadata.name' "$tmp/ks.yaml")" == "app-$name" && "$(yq '.metadata.namespace' "$tmp/ks.yaml")" == "flux-system" ]] \
        || fail "the rendered Kustomization must be flux-system/app-$name"
    [[ "$(yq '.spec.deletionPolicy' "$tmp/ks.yaml")" == "Orphan" ]] || fail "rendered Kustomization: deletionPolicy must be Orphan"
    [[ "$(yq '.spec.wait' "$tmp/ks.yaml")" == "true" ]] || fail "rendered Kustomization: wait must be true"
    [[ "$(yq '.spec.decryption.provider' "$tmp/ks.yaml")" == "sops" ]] || fail "rendered Kustomization: decryption.provider must be sops"
    [[ "$(yq '.spec.targetNamespace' "$tmp/ks.yaml")" == "$ns" ]] || fail "rendered Kustomization: targetNamespace must be $ns"
    sub_ok="$(yq '[.spec.postBuild.substitute | to_entries[] | .value | tag == "!!str"] | all' "$tmp/ks.yaml")"
    [[ "$sub_ok" == "true" ]] || fail "rendered Kustomization: every postBuild.substitute value must be a string"
    ! grep -qF 'fluxcd.controlplane.io/force' "$tmp/rset-apps.yaml" || fail "the render sets fluxcd.controlplane.io/force"
    if grep -qxF "app-$name" "$tmp/ks.names"; then
        fail "a Flux Kustomization named app-$name is declared in Git"
    fi
    [[ "$(yq '.spec.path' "$tmp/ks.yaml")" == "${path:-$base_path}" ]] || fail "rendered Kustomization: unexpected spec.path"

    # 7. The pull Secret that apps-pull renders.
    secret_pull=false
    echo "$parts_json" | jq -e 'index("pullsecret") != null' >/dev/null && secret_pull=true
    if flux-operator build rset -f "$rs_pull" --inputs-from-provider "$tmp/static.yaml" >"$tmp/rset-pull.yaml" 2>"$tmp/rset.err"; then
        [[ "$secret_pull" == true ]] || fail "apps-pull rendered objects for an entry without the pullsecret part"
        ! grep -qF 'fluxcd.controlplane.io/force' "$tmp/rset-pull.yaml" || fail "the apps-pull render sets fluxcd.controlplane.io/force"
        n="$(yq -N 'select(.kind == "Secret") | .metadata.name' "$tmp/rset-pull.yaml" | grep -c . || true)"
        [[ "$n" == "1" \
            && "$(yq -N 'select(.kind == "Secret") | .metadata.name' "$tmp/rset-pull.yaml")" == "apps-ghcr" \
            && "$(yq -N 'select(.kind == "Secret") | .metadata.namespace' "$tmp/rset-pull.yaml")" == "$ns" \
            && "$(yq -N 'select(.kind == "Secret") | .type' "$tmp/rset-pull.yaml")" == "kubernetes.io/dockerconfigjson" \
            && "$(yq -N 'select(.kind == "Secret") | .metadata.annotations["fluxcd.controlplane.io/copyFrom"]' "$tmp/rset-pull.yaml")" == "flux-system/ghcr-apps-read" \
            && "$(yq -N 'select(.kind == "Secret") | .metadata.annotations["fluxcd.controlplane.io/prune"]' "$tmp/rset-pull.yaml")" == "disabled" ]] \
            || fail "apps-pull must render one dockerconfigjson Secret apps-ghcr in $ns with copyFrom flux-system/ghcr-apps-read and prune: disabled"
    else
        # The CLI exits 1 when nothing renders; the controller accepts that.
        if [[ "$secret_pull" == true ]] || ! grep -q 'no objects were generated' "$tmp/rset.err"; then
            fail "flux-operator build rset (apps-pull) failed: $(cat "$tmp/rset.err")"
        fi
    fi

    # 4. Build the Kustomization as Flux would, with stand-in zones.
    yq ".spec.postBuild.substitute.SECRET_DOMAIN_LOCAL = \"$fake_local\" | .spec.postBuild.substitute.SECRET_FAMILY_DOMAIN = \"$fake_family\"" "$tmp/ks.yaml" >"$tmp/ks-build.yaml"
    flux build ks "app-$name" --namespace flux-system --dry-run --path "${path:-$base_path}" \
        --kustomization-file "$tmp/ks-build.yaml" >"$tmp/build.yaml" 2>"$tmp/build.err" \
        || fail "flux build ks failed: $(cat "$tmp/build.err")"
    conform <"$tmp/ks.yaml" >"$tmp/conform.out" 2>&1 || fail "kubeconform (rendered Kustomization): $(cat "$tmp/conform.out")"
    conform <"$tmp/build.yaml" >"$tmp/conform.out" 2>&1 || fail "kubeconform (built objects): $(cat "$tmp/conform.out")"
    ! grep -qF 'fluxcd.controlplane.io/force' "$tmp/build.yaml" || fail "the build sets fluxcd.controlplane.io/force"

    # 4-6. Restricted pods, no credentials, the network policy and the routes.
    yq -o=json -N '.' "$tmp/build.yaml" | jq -s '[.[] | select(type == "object")]' >"$tmp/build.json"
    # A variable left in the build would be a typo. Only container env values
    # may hold a literal ${...}: that is what the documented $${...} escape in
    # `env` becomes after substitution.
    errs="$(jq -r '[.[] | walk(if type == "object" and has("env") then del(.env) else . end) | .. | strings | select(contains("${"))] | unique | join(" ")' "$tmp/build.json")"
    [[ -z "$errs" ]] || fail "the build has an unsubstituted \${...} outside container env: $errs"
    errs="$(jq -r --arg ns "$ns" --argjson pull "$pull_json" "$pods_jq" "$tmp/build.json")"
    [[ -z "$errs" ]] || fail "pods: $(printf '%s\n' "$errs" | sed '2,$s/^/    /')"
    errs="$(jq -r --arg ns "$ns" --arg name "$name" --argjson netpol "$netpol" --arg egress "$egress" \
        --argjson parts "$parts_json" --arg host "$host" --arg famhost "$famhost" \
        --arg local "$fake_local" --arg family "$fake_family" "$netpol_jq" "$tmp/build.json")"
    [[ -z "$errs" ]] || fail "network policy or routes: $(printf '%s\n' "$errs" | sed '2,$s/^/    /')"

    # Cross-entry facts, checked once all entries are known.
    printf '%s\n' "$ns" >>"$tmp/entry.namespaces"
    yq '.spec.defaultValues.vars.VOLSYNC_SCHEDULE // ""' "$file" >>"$tmp/entry.volsync"
    yq '.spec.defaultValues.vars.SQLITE_SCHEDULE // ""' "$file" >>"$tmp/entry.sqlite"
    echo "    ok: $name in $ns (components: $(yq '[.spec.components[]? | sub(".*/", "")] | join(" ")' "$tmp/ks.yaml"))"
}

# --- Cross-entry checks ------------------------------------------------------

check_unique() {
    local list="$1" what="$2" dup
    dup="$(grep -v '^$' "$list" | sort | uniq -d || true)"
    [[ -z "$dup" ]] || die "$what shared by two entries: $(echo "$dup" | tr '\n' ' ')"
}

check_cross_entry() {
    local s
    check_unique "$tmp/entry.namespaces" "namespace (one namespace per app)"
    check_unique "$tmp/entry.volsync" "VOLSYNC_SCHEDULE"
    check_unique "$tmp/entry.sqlite" "SQLITE_SCHEDULE"
    # A slot used by a Git-defined app (jellyfin, quilt-planner, ...) is taken too.
    while IFS= read -r s; do
        [[ -n "$s" ]] || continue
        ! grep -qxF "$s" "$tmp/git.volsync" || die "VOLSYNC_SCHEDULE '$s' is also used by a Kustomization in Git"
    done <"$tmp/entry.volsync"
    while IFS= read -r s; do
        [[ -n "$s" ]] || continue
        ! grep -qxF "$s" "$tmp/git.sqlite" || die "SQLITE_SCHEDULE '$s' is also used by a Kustomization in Git"
    done <"$tmp/entry.sqlite"
}

# The names in retired.txt: valid, and without an entry file.
check_retired_list() {
    local name
    : >"$tmp/retired.list"
    [[ -f "$retired_file" ]] || die "$retired_file is missing"
    sed -e 's/#.*//' -e 's/[[:space:]]*$//' -e 's/^[[:space:]]*//' "$retired_file" | grep -v '^$' >"$tmp/retired.list" || true
    while IFS= read -r name; do
        [[ "$name" =~ ^[a-z][a-z0-9-]*$ ]] || die "$retired_file: '$name' is not an app name"
        [[ ! -f "$apps_dir/$name.yaml" ]] \
            || die "$retired_file lists $name, but $apps_dir/$name.yaml exists (a retired app has no entry)"
    done <"$tmp/retired.list"
}

# An existing entry keeps its name and namespace: either change starts a new,
# empty app (the old one is orphaned). A rename is a new file name, so an
# in-place comparison cannot see it: any entry file that exists on the base
# branch and is gone now must be listed in retired.txt, which turns a rename
# into an explicit retire plus add.
check_renames() {
    local ref="$APPS_BASE_REF" f was now name
    git rev-parse --verify -q "$ref^{commit}" >/dev/null || die "APPS_BASE_REF $ref is not a commit here (fetch it)"
    while IFS= read -r f; do
        [[ "$(basename "$f")" != kustomization.yaml ]] || continue
        if [[ ! -f "$f" ]]; then
            name="$(basename "$f" .yaml)"
            grep -qxF "$name" "$tmp/retired.list" \
                || die "$f was deleted (or renamed) since $ref: a deleted entry orphans the app and a rename starts a new, empty one. If that is intended, list '$name' in $retired_file in the same PR"
            continue
        fi
        was="$(git show "$ref:$f" | yq '(.spec.defaultValues.name // "") + " " + (.spec.defaultValues.namespace // .spec.defaultValues.name // "")')"
        now="$(yq '(.spec.defaultValues.name // "") + " " + (.spec.defaultValues.namespace // .spec.defaultValues.name // "")' "$f")"
        [[ "$was" == "$now" ]] || die "$f: name/namespace changed from '$was' to '$now' (never rename an existing entry: it starts a new empty app)"
    done < <(git ls-tree -r --name-only "$ref" -- "$apps_dir")
    echo "--- renames: no entry deleted or renamed against $ref (retired: $(tr '\n' ' ' <"$tmp/retired.list"))"
}

# The Deployment alert lists the namespaces of the platform apps (kube-state-metrics
# does not export namespace labels), so a new entry must be added to it.
check_alert_namespaces() {
    local rule="kubernetes/apps/observability/kube-prometheus-stack/app/prometheusrule-app-platform.yaml" list ns
    [[ -f "$rule" ]] || die "$rule is missing: do not deploy an app without alerts"
    list="$(yq '.spec.groups[].rules[] | select(.alert == "AppPlatformDeploymentUnavailable") | .expr' "$rule" \
        | sed -nE 's/.*namespace=~"([^"]*)".*/\1/p')"
    [[ -n "$list" ]] || die "$rule: AppPlatformDeploymentUnavailable has no namespace=~\"...\" matcher"
    while IFS= read -r ns; do
        [[ -n "$ns" ]] || continue
        printf '%s\n' "$list" | tr '|' '\n' | grep -qxF "$ns" \
            || die "namespace $ns is not in the AppPlatformDeploymentUnavailable matcher in $rule (add it with the entry)"
    done <"$tmp/entry.namespaces"
    echo "--- alerts: every entry namespace is in AppPlatformDeploymentUnavailable"
}

# The alert rules, syntax and behaviour. `promtool check rules` passed a rule
# on a metric that does not exist, so the unit tests feed series under the names
# and labels flux-operator exports and expect the alerts to fire.
check_rules() {
    local rule="kubernetes/apps/observability/kube-prometheus-stack/app/prometheusrule-app-platform.yaml"
    local test_file="$script_dir/validate-apps/prometheusrule-app-platform.test.yaml"
    [[ -f "$test_file" ]] || die "$test_file is missing"
    mkdir -p "$tmp/rules"
    yq '.spec' "$rule" >"$tmp/rules/app-platform-rules.yaml"
    cp "$test_file" "$tmp/rules/"
    promtool check rules "$tmp/rules/app-platform-rules.yaml" >"$tmp/rules.out" 2>&1 \
        || die "promtool check rules failed: $(cat "$tmp/rules.out")"
    (cd "$tmp/rules" && promtool test rules "$(basename "$test_file")") >"$tmp/rules.out" 2>&1 \
        || die "promtool test rules failed: $(cat "$tmp/rules.out")"
    echo "--- alerts: promtool check and unit tests pass"
}

# --- 6. gitleaks -------------------------------------------------------------

scan_secrets() {
    local d
    gitleaks dir --no-banner --redact "$apps_dir" >"$tmp/gitleaks.out" 2>&1 || die "gitleaks found a secret in $apps_dir: $(cat "$tmp/gitleaks.out")"
    while IFS= read -r d; do
        [[ -n "$d" ]] || continue
        gitleaks dir --no-banner --redact "$d" >"$tmp/gitleaks.out" 2>&1 || die "gitleaks found a secret in $d: $(cat "$tmp/gitleaks.out")"
    done < <(for f in "$apps_dir"/*.yaml; do yq '.spec.defaultValues.path // ""' "$f"; done | grep -v '^$' | sort -u | sed 's#^\./##')
    echo "--- gitleaks: no secrets in the entries or custom folders"
}

# --- Fixtures ----------------------------------------------------------------

# Throwaway samples under scripts/validate-apps/fixtures. pass/ must validate;
# every file in fail/ must be rejected, with the text on its `# expect:` line.
# pass/hello-default.yaml is a copy of the hello entry, so that the tests do not
# depend on whether the live entry is in the tree.
run_self_test() {
    local f expect out rc passed=0 failed=0
    for f in "$fixtures_dir"/pass/*.yaml; do
        [[ -f "$f" ]] || continue
        if out="$("$script_path" --entry "$f" 2>&1)"; then
            echo "pass  $f"
            passed=$((passed + 1))
        else
            echo "FAIL  $f should validate:" >&2
            printf '%s\n' "$out" >&2
            failed=$((failed + 1))
        fi
    done
    for f in "$fixtures_dir"/fail/*.yaml; do
        [[ -f "$f" ]] || continue
        expect="$(sed -n 's/^# expect: //p' "$f")"
        [[ -n "$expect" ]] || die "$f has no '# expect:' line"
        rc=0
        out="$("$script_path" --entry "$f" 2>&1)" || rc=$?
        if ((rc != 0)) && [[ "$out" == *"$expect"* ]]; then
            echo "reject $f ($expect)"
            passed=$((passed + 1))
        else
            echo "FAIL  $f should be rejected with '$expect' (exit $rc):" >&2
            printf '%s\n' "$out" >&2
            failed=$((failed + 1))
        fi
    done
    echo "self-test: $passed ok, $failed failed"
    ((failed == 0)) || exit 1
}

# --- Main --------------------------------------------------------------------

main() {
    local mode=all entry="" root="" f
    while (($# > 0)); do
        case "$1" in
            --self-test) mode=selftest ;;
            --entry) mode=entry; entry="${2:?--entry needs a file}"; shift ;;
            -h | --help) sed -n '2,12p' "$script_path"; exit 0 ;;
            *) root="$1" ;;
        esac
        shift
    done
    root="${root:-$(git -C "$script_dir" rev-parse --show-toplevel)}"
    cd "$root"

    if [[ ! -d "$platform_dir" ]]; then
        echo "validate-apps: no app platform in $root, skipped"
        return 0
    fi
    [[ -d "$apps_dir" ]] || die "$apps_dir is missing (an empty entries folder still has its kustomization.yaml)"

    require_tools
    setup_cache
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT

    case "$mode" in
        selftest) run_self_test; return ;;
        entry)
            collect_git_facts
            validate_entry "$entry"
            return
            ;;
    esac

    echo "=== app platform ==="
    # The credential first: it is the one input an agent cannot create, so a
    # missing file must be the first thing the log shows.
    check_credential
    collect_git_facts
    check_tooling
    check_templates_in_sync
    : >"$tmp/entry.namespaces" && : >"$tmp/entry.volsync" && : >"$tmp/entry.sqlite"
    for f in "$apps_dir"/*.yaml; do
        [[ "$(basename "$f")" != kustomization.yaml ]] || continue
        validate_entry "$f"
    done
    entry_label="validate-apps"
    # Every entry file is listed in apps/kustomization.yaml and vice versa.
    for f in "$apps_dir"/*.yaml; do
        [[ "$(basename "$f")" != kustomization.yaml ]] || continue
        yq -e ".resources[] | select(. == \"./$(basename "$f")\")" "$apps_dir/kustomization.yaml" >/dev/null 2>&1 \
            || die "$apps_dir/kustomization.yaml does not list ./$(basename "$f")"
    done
    check_cross_entry
    check_retired_list
    check_alert_namespaces
    check_rules
    scan_secrets
    if [[ -n "${APPS_BASE_REF:-}" ]]; then
        check_renames
    else
        echo "--- renames: skipped (APPS_BASE_REF not set; the Kubernetes workflow sets it on pull requests)"
    fi
    echo "=== app platform is valid ==="
}

main "$@"
