#!/usr/bin/env bash
# Validates the personal app platform: the entries under
# kubernetes/apps/flux-system/app-platform/apps, the two ResourceSets that
# render them, and everything those render.
#
#   validate-apps.sh [ROOT]        validate every entry under ROOT (default: repo root)
#   validate-apps.sh --entry FILE  validate one entry file (also used for the fixtures)
#   validate-apps.sh --self-test   run the fixtures: scripts/validate-apps/fixtures
#   validate-apps.sh --structure ROOT   only check the shape of the app-platform folders
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
#      message, because it is created by the owner, never by an agent; then the
#      shape of the folders that the cluster-admin Kustomization app-platform
#      applies (apps/ holds only entry files, each a single
#      ResourceSetInputProvider, and its kustomization.yaml lists exactly them;
#      app/ holds only the known objects);
#   1. the entry: only schema keys, names, parts, netpol/egress rules, env and
#      vars rules (with the scheduled job's command, paths and egress CIDR),
#      retain-class storage, unique schedules and namespaces;
#   2. `flux-operator build rset` for both ResourceSets (the CLI only takes
#      Static providers, so type is rewritten and a fake digest injected);
#   3. the rendered Kustomization: Orphan, wait, SOPS, string-only substitution,
#      no name clash with a Kustomization in Git, no force annotation;
#   4. `flux build ks --dry-run | kubeconform`, restricted pod fields and the
#      route rules;
#   5. the network policy, compared field by field with the design, and with
#      job-egress the job's own policy (its allow rule and its deny rules for
#      the own namespace and claude-proxy); only the job's CronJob carries the
#      job pod label that policy selects; with share, the second policy
#      <name>-share (cloudflared to 3001/TCP only), the Service <name>-share
#      (only 3001) and the three GUEST_ variables; with share-admin, the second
#      policy <name>-share-admin (egress from the app pod to the share-admin
#      pods on 8080/TCP only) and the fixed SHARE_ADMIN_URL;
#   6. no credentials: no Secret reference in any pod spec, no service-account
#      token, and gitleaks over the entries and every custom folder. The one
#      exception is the mapkit part: the app's Deployment, container app, may
#      read the one key MAPKIT_TOKEN of the Secret <name>-mapkit;
#   6a. custom `path` folders on their own: plain workload kinds only;
#   7. the pull Secret that `apps-pull` renders;
#   8. the Namespace folder under kubernetes/apps/personal-apps, and renames;
#      with the mapkit part, its SOPS Secret mapkit.sops.yaml there; with the
#      share part, the folder <name>-share/ for its cloudflared;
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
fake_domain="example.test"
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
# the pull Secrets (kubernetes.io/dockerconfigjson) declared in Git, the names of
# Flux Kustomizations declared in Git and the backup schedules they set. Only a
# pull Secret may be vars.PULL_SECRET, so the mapkit Secret can never be one.
collect_git_facts() {
    local f
    find kubernetes -type f -name '*.yaml' ! -name kustomization.yaml -print0 | sort -z >"$tmp/all-manifests"
    : >"$tmp/retain.list" && : >"$tmp/secrets.list" && : >"$tmp/ks.names"
    : >"$tmp/git.volsync" && : >"$tmp/git.sqlite"
    while IFS= read -r -d '' f; do
        yq -N 'select(.kind == "StorageClass" and .reclaimPolicy == "Retain") | .metadata.name' "$f" >>"$tmp/retain.list"
        yq -N 'select(.kind == "Secret" and .type == "kubernetes.io/dockerconfigjson") | .metadata.name' "$f" >>"$tmp/secrets.list"
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
    [[ -f "$credential" ]] || die "$credential is missing: create it before merging. It is the registry token (classic read:packages) every app Kustomization and image pull uses, and only the owner creates it. See 'Creating ghcr-apps-read' in kubernetes/apps/personal-apps/README.md"
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

# --- The folders a cluster-admin Kustomization applies ----------------------

# app-platform is applied by kustomize-controller as cluster-admin, and applies
# whatever app-platform/kustomization.yaml, app/ and apps/ list. A reviewer
# reading a diff is the only other guard, so the shape is fixed here: apps/ holds
# kustomization.yaml and one top-level <name>.yaml per entry, each a single
# ResourceSetInputProvider, and kustomization.yaml lists exactly those files (no
# subfolder, no other resource, no generator, patch or component); app/ holds only
# the known objects. Works on the tree it runs in, so the self-test can feed it
# broken copies (--structure ROOT).
check_structure() {
    local f name entry_files=() expected_json kinds item expected rel
    # The platform folder itself.
    while IFS= read -r -d '' f; do
        name="$(basename "$f")"
        case "$name" in
            ks.yaml | kustomization.yaml | retired.txt) [[ -f "$f" && ! -L "$f" ]] || die "$f must be a regular file" ;;
            app | apps) [[ -d "$f" && ! -L "$f" ]] || die "$f must be a folder" ;;
            *) die "$f is not allowed in $platform_dir (ks.yaml, kustomization.yaml, retired.txt, app/, apps/ only)" ;;
        esac
    done < <(find "$platform_dir" -mindepth 1 -maxdepth 1 -print0)
    yq -o=json '.' "$platform_dir/kustomization.yaml" \
        | jq -e '(keys == ["apiVersion", "kind", "resources"]) and .apiVersion == "kustomize.config.k8s.io/v1beta1" and .kind == "Kustomization" and (.resources == ["./app", "./apps"])' >/dev/null \
        || die "$platform_dir/kustomization.yaml must be a Kustomization that lists exactly ./app and ./apps, with no other key"
    yq -o=json -N '.' "$platform_dir/ks.yaml" \
        | jq -s -e 'length == 1 and (.[0] | .kind == "Kustomization" and .metadata.name == "app-platform"
            and .spec.path == "./kubernetes/apps/flux-system/app-platform"
            and ((.spec | keys) - ["dependsOn", "decryption", "interval", "path", "prune", "sourceRef", "targetNamespace", "wait"] == []))' >/dev/null \
        || die "$platform_dir/ks.yaml must be the Kustomization app-platform for $platform_dir, with no postBuild, patches, components, kubeConfig or serviceAccountName"

    # apps/: entries only.
    while IFS= read -r -d '' f; do
        name="$(basename "$f")"
        if [[ -d "$f" || -L "$f" ]]; then
            die "$f is a folder or a link: $apps_dir holds only kustomization.yaml and top-level <name>.yaml files"
        fi
        if [[ "$name" == kustomization.yaml ]]; then continue; fi
        [[ "$name" =~ ^[a-z][a-z0-9-]*\.yaml$ ]] \
            || die "$f is not allowed in $apps_dir (only kustomization.yaml and top-level <name>.yaml entry files)"
        [[ "$(yq ea '[.] | length' "$f")" == "1" ]] || die "$f must hold exactly one document"
        kinds="$(yq -N '.apiVersion + " " + .kind' "$f")"
        [[ "$kinds" == "fluxcd.controlplane.io/v1 ResourceSetInputProvider" ]] \
            || die "$f is not a single fluxcd.controlplane.io/v1 ResourceSetInputProvider (found: $kinds)"
        entry_files+=("./$name")
    done < <(find "$apps_dir" -mindepth 1 -maxdepth 1 -print0)
    [[ -f "$apps_dir/kustomization.yaml" ]] || die "$apps_dir/kustomization.yaml is missing"
    expected_json="$(printf '%s\n' ${entry_files[@]+"${entry_files[@]}"} | jq -R . | jq -s 'map(select(. != "")) | sort')"
    yq -o=json '.' "$apps_dir/kustomization.yaml" \
        | jq -e --argjson want "$expected_json" '(keys == ["apiVersion", "kind", "resources"]) and .apiVersion == "kustomize.config.k8s.io/v1beta1" and .kind == "Kustomization" and ((.resources | sort) == $want) and ((.resources | length) == ($want | length))' >/dev/null \
        || die "$apps_dir/kustomization.yaml must be a Kustomization with only apiVersion, kind and resources, and its resources must be exactly the entry files here (${entry_files[*]:-none}): no subfolder, no other resource, no generator, patch or component"

    # app/: the known objects only.
    while IFS= read -r -d '' f; do
        name="$(basename "$f")"
        if [[ -d "$f" || -L "$f" ]]; then die "$f is a folder or a link: $app_dir holds only the known files"; fi
        case "$name" in
            kustomization.yaml | alert.yaml | provider.yaml | resourceset.yaml | resourceset-pull.yaml | discord-webhook.sops.yaml | ghcr-apps-read.sops.yaml) ;;
            *) die "$f is not one of the known files of $app_dir (alert, provider, the two ResourceSets, the two Secrets)" ;;
        esac
        [[ "$name" != kustomization.yaml ]] || continue
        case "$name" in
            alert.yaml) expected="notification.toolkit.fluxcd.io/v1beta3 Alert/apps" ;;
            provider.yaml) expected="notification.toolkit.fluxcd.io/v1beta3 Provider/discord" ;;
            resourceset.yaml) expected="fluxcd.controlplane.io/v1 ResourceSet/apps" ;;
            resourceset-pull.yaml) expected="fluxcd.controlplane.io/v1 ResourceSet/apps-pull" ;;
            discord-webhook.sops.yaml) expected="v1 Secret/discord-webhook" ;;
            ghcr-apps-read.sops.yaml) expected="v1 Secret/ghcr-apps-read" ;;
        esac
        [[ "$(yq ea '[.] | length' "$f")" == "1" ]] || die "$f must hold exactly one document"
        item="$(yq -N '.apiVersion + " " + .kind + "/" + .metadata.name' "$f")"
        [[ "$item" == "$expected" ]] || die "$f must be $expected, not $item"
    done < <(find "$app_dir" -mindepth 1 -maxdepth 1 -print0)
    [[ -f "$app_dir/kustomization.yaml" ]] || die "$app_dir/kustomization.yaml is missing"
    yq -o=json '.' "$app_dir/kustomization.yaml" \
        | jq -e '(keys == ["apiVersion", "kind", "resources"]) and .apiVersion == "kustomize.config.k8s.io/v1beta1" and .kind == "Kustomization"
            and ((.resources | sort) == ["./alert.yaml", "./discord-webhook.sops.yaml", "./ghcr-apps-read.sops.yaml", "./provider.yaml", "./resourceset-pull.yaml", "./resourceset.yaml"])' >/dev/null \
        || die "$app_dir/kustomization.yaml must list exactly alert, discord-webhook, ghcr-apps-read, provider, resourceset-pull and resourceset, with no other key"
    rel="$platform_dir"
    echo "--- structure: $rel holds only the known files, each of the known kind, and the entries are listed exactly"
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
    if ! { grep -qF '$name := get inputs "name" | default ""' "$rs_apps" \
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
def yamlword: isstr and (ascii_downcase | IN("y", "yes", "n", "no", "true", "false", "on", "off", "null"));
def qty: ((isstr) or (type == "number")) and (tostring | test("^[0-9]+(\\.[0-9]+)?(m|k|M|G|T|Ki|Mi|Gi|Ti)?$"));
# The scheduled job. Flux substitutes after kustomize has re-serialized the
# CronJob, so quotes around ${JOB_...} are gone and each value must read as a
# plain YAML string of the right type. A path starts with a letter (never a
# number) and is not a YAML boolean or null word; its segments never start with
# a dot (no hidden folder, no . or ..).
def jobpath: isstr and test("^[A-Za-z][A-Za-z0-9._-]*(/[A-Za-z0-9_][A-Za-z0-9._-]*)*$") and (yamlword | not);
def octet: "(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])";
def cidr4: isstr and test("^\(octet)\\.\(octet)\\.\(octet)\\.\(octet)/(1[6-9]|2[0-9]|3[0-2])$");
def cidrnum: split("/") | {a: (.[0] | split(".") | map(tonumber) | .[0] * 16777216 + .[1] * 65536 + .[2] * 256 + .[3]), p: (.[1] | tonumber)};
# No bitwise operators in jq: two ranges overlap when their addresses agree on
# the shorter of the two prefixes.
def overlaps($o): (cidrnum) as $x | ($o | cidrnum) as $y | pow(2; 32 - ([$x.p, $y.p] | min)) as $s
  | (($x.a / $s) | floor) == (($y.a / $s) | floor);
def hostbitszero: cidrnum | pow(2; 32 - .p) as $s | ((.a / $s) | floor) * $s == .a;
# The except list of netpol-egress-internet (keep the two equal), plus "this
# network" and loopback.
def notpublic: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "192.0.0.0/24", "198.18.0.0/15", "224.0.0.0/3", "0.0.0.0/8", "127.0.0.0/8"];
# The ranges the API server's cron parser accepts: each comma-separated item is
# *, a value or a range a-b, optionally with a step /n (n >= 1). Month and
# weekday also take names.
def cronv($names): ascii_downcase as $x | if ($x | test("^[0-9]+$")) then ($x | tonumber) else ($names | index($x)) end;
def cronitem($lo; $hi; $names):
  (capture("^(?<a>\\*|[0-9A-Za-z]+)(-(?<b>[0-9A-Za-z]+))?(/(?<s>[0-9]+))?$") // {bad: true}) as $m
  | if $m.bad then false
    elif $m.s != null and ($m.s | tonumber) < 1 then false
    elif $m.a == "*" then $m.b == null
    else ($m.a | cronv($names)) as $from | (if $m.b == null then $from else ($m.b | cronv($names)) end) as $to
      | $from != null and $to != null and $from >= $lo and $to <= $hi and $from <= $to
    end;
def cronfield($lo; $hi; $names): split(",") | all(.[]; cronitem($lo; $hi; $names));
def cronranges: split(" ") as $f
  | ($f[0] | cronfield(0; 59; [])) and ($f[1] | cronfield(0; 23; [])) and ($f[2] | cronfield(1; 31; []))
    and ($f[3] | cronfield(1; 12; ["", "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]))
    and ($f[4] | cronfield(0; 6; ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]));
# A quantity in bytes (valid quantities only).
def qtybytes: tostring | capture("^(?<n>[0-9]+(\\.[0-9]+)?)(?<u>m|k|M|G|T|Ki|Mi|Gi|Ti)?$")
  | (.n | tonumber) * {"": 1, "m": 0.001, "k": 1000, "M": 1000000, "G": 1000000000, "T": 1000000000000, "Ki": 1024, "Mi": 1048576, "Gi": 1073741824, "Ti": 1099511627776}[.u // ""];
. as $e
| (if ($e.spec.defaultValues | type) == "object" then $e.spec.defaultValues else {} end) as $d
| (if ($d.vars | type) == "object" then $d.vars else {} end) as $v
| (if ($d.env | type) == "object" then $d.env else {} end) as $env
| (if ($d.name | isstr) then $d.name else "" end) as $name
| (if ($d.namespace | isstr) then $d.namespace else $name end) as $ns
| (if ($d.parts | type) == "array" then $d.parts else ["pullsecret", "internal-route", "backup"] end) as $parts
| ["pullsecret", "internal-route", "family-route", "family-route-legacy", "backup", "backup-sqlite", "job", "job-egress", "mapkit", "share", "share-admin"] as $known
| ["name", "namespace", "parts", "netpol", "netpolReason", "egress", "pin", "env", "path", "vars"] as $topkeys
| ["CLAIM", "STORAGE", "STORAGE_CLASS", "HEALTH_PATH", "APP_UID", "APP_GID", "DATA_PATH", "CPU", "MEMORY", "MEMORY_LIMIT", "IMAGE", "PULL_SECRET", "HOST", "FAMILY_HOST", "TITLE", "DESCRIPTION", "ICON", "SQLITE_DBS", "VOLSYNC_SCHEDULE", "SQLITE_SCHEDULE", "JOB_SCHEDULE", "JOB_COMMAND", "JOB_READ_PATH", "JOB_WORK_PATH", "JOB_DEADLINE", "JOB_MEMORY_LIMIT", "JOB_EGRESS_CIDR", "SHARE_HOST", "GUEST_COLLECTIONS"] as $varkeys
| ["APP", "IMAGE_DIGEST", "APP_NAMESPACE", "VOLSYNC_NAMESPACE", "VOLSYNC_CLAIM"] as $reserved
| [
    (if $e.apiVersion != "fluxcd.controlplane.io/v1" or $e.kind != "ResourceSetInputProvider" then "must be a fluxcd.controlplane.io/v1 ResourceSetInputProvider" else empty end),
    (if ($e.spec.defaultValues | type) != "object" then "spec.defaultValues must be a map" else empty end),
    (if $e.metadata.namespace != "flux-system" then "metadata.namespace must be flux-system" else empty end),
    (if ($e.metadata.labels["platform/apps"] // "") != "true" then "label platform/apps: \"true\" is required (both ResourceSets select on it)" else empty end),
    (if ($d.name | isstr | not) then "defaultValues.name is required"
     elif ($name | test("^[a-z][a-z0-9-]*$") | not) then "name \($name) must match ^[a-z][a-z0-9-]*$ (a numeric name would become an integer after substitution)"
     elif ($name | yamlword) then "name \($name) is a YAML boolean or null word (it would not stay a string after substitution)"
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
    (if ($d | has("namespace")) and ($d.namespace | lbl | not) then "namespace \($d.namespace) must be a lowercase DNS label"
     elif ($d | has("namespace")) and $d.namespace != $name then "namespace \($d.namespace) differs from name \($name): an app lives in the namespace of its own name (its network policy is namespace-wide and would default-deny another app's pods)"
     else empty end),
    # parts
    (if ($d | has("parts")) and ($d.parts | type) != "array" then "parts must be a list" else empty end),
    ($parts | map(select(isstr | not)) | if length > 0 then "parts must be strings" else empty end),
    ($parts[] | select(isstr) | select(IN($known[]) | not) | if . == "namespace" then "`namespace` is not a part and is rejected (it is a setting)" else "unknown part \(.)" end),
    (if ($parts | length) != ($parts | unique | length) then "duplicate parts" else empty end),
    (if ($parts | index("family-route-legacy")) != null and (($parts | index("family-route")) == null or ($parts | index("family-route")) > ($parts | index("family-route-legacy"))) then "family-route-legacy patches the route of family-route, so family-route must come before it in parts" else empty end),
    (if ($parts | index("family-route")) != null and (($v.FAMILY_HOST | lbl) | not) then "family-route needs vars.FAMILY_HOST (a DNS label)" else empty end),
    # share: the guest port, its Service and policy, and the host and collections they serve
    (if ($parts | index("share")) != null then
       (if (($v.SHARE_HOST | lbl) | not) then "share needs vars.SHARE_HOST (a DNS label: the guest host is <SHARE_HOST>.<zone>)" else empty end),
       (if (($v.GUEST_COLLECTIONS | isstr) | not) or (($v.GUEST_COLLECTIONS | test("^[a-z0-9]([-a-z0-9]*[a-z0-9])?(,[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$")) | not) then "share needs vars.GUEST_COLLECTIONS, collection names separated by commas (lowercase letters, digits and -)"
        elif ($v.GUEST_COLLECTIONS | split(",") | any(test("[a-z]") | not)) then "vars.GUEST_COLLECTIONS: every collection name needs at least one letter (a number would not stay a string after substitution)"
        elif ($v.GUEST_COLLECTIONS | split(",") | any(yamlword)) then "vars.GUEST_COLLECTIONS: a collection name must not be a YAML boolean or null word (y, yes, n, no, on, off, true, false, null)"
        else empty end),
       (if $name != "reports" and ($fx | not) then "the share part is allowed only for the reports entry for now" else empty end),
       (if $d.netpol == false then "share has no meaning with netpol: false (its policy admits cloudflared to port 3001)" else empty end)
     else
       (if ($v | has("SHARE_HOST")) then "vars.SHARE_HOST needs the share part" else empty end),
       (if ($v | has("GUEST_COLLECTIONS")) then "vars.GUEST_COLLECTIONS needs the share part" else empty end)
     end),
    (if ($v | has("SHARE_HOST")) and ($v.SHARE_HOST | lbl | not) then "vars.SHARE_HOST must be a lowercase DNS label" else empty end),
    # share-admin: the app pod may ask the share-admin service (outside the platform) to edit the guest list
    (if ($parts | index("share-admin")) != null then
       (if $name != "reports" and ($fx | not) then "the share-admin part is allowed only for the reports entry for now (the service's policy admits only that app)" else empty end),
       (if $d.netpol == false then "share-admin has no meaning with netpol: false (its policy opens egress to the share-admin pods)" else empty end)
     else empty end),
    # netpol and egress
    (if ($d | has("netpol")) and ($d.netpol | type) != "boolean" then "netpol must be true or false" else empty end),
    (if $d.netpol == false and (($d.netpolReason | isstr | not) or ($d.netpolReason | gsub("\\s"; "") == "")) then "netpol: false needs a non-empty netpolReason" else empty end),
    (if ($d | has("egress")) and ((($d.egress | type) != "string") or (["none", "internet", "claude-proxy"] | index($d.egress) == null)) then "egress must be none, internet or claude-proxy" else empty end),
    (if $d.netpol == false and ($d.egress // "none") != "none" then "egress: \($d.egress) has no meaning with netpol: false" else empty end),
    # pin
    (if ($d | has("pin")) and (($d.pin | isstr | not) or ($d.pin | test("^sha256:[0-9a-f]{64}$") | not)) then "pin must be sha256:<64 hex digits>" else empty end),
    # env
    (if ($d | has("env")) and ($d.env | type) != "object" then "env must be a map of plain strings" else empty end),
    ($env | to_entries[]
      | (if (.key | test("^[A-Z][A-Z0-9_]*$") | not) then "env key \(.key) must be uppercase letters, digits and _" else empty end),
        (if (.key | IN("N", "Y", "ON", "OFF")) then "env key \(.key) is a YAML boolean" else empty end),
        (if (.key | secretish) then "env key \(.key) looks like a credential name (apps hold no credentials)" else empty end),
        (if (.key == "PORT" or .key == "SHARE_ADMIN_URL" or (.key | startswith("GUEST_"))) then "env key \(.key) is reserved: the platform sets PORT, the share part sets the GUEST_ variables and the share-admin part sets SHARE_ADMIN_URL" else empty end),
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
      | if $ps != "apps-ghcr" and ($ps | tostring | IN($pullsecrets[]) | not) then "vars.PULL_SECRET \($ps) is not a Secret declared in Git (only kubernetes.io/dockerconfigjson Secrets count)" else empty end),
    (("CPU", "MEMORY", "MEMORY_LIMIT", "STORAGE", "JOB_MEMORY_LIMIT") as $k
      | if ($v | has($k)) and ($v[$k] | qty | not) then "vars.\($k) is not a Kubernetes quantity" else empty end),
    (if ($v | has("HEALTH_PATH")) and (($v.HEALTH_PATH | isstr | not) or ($v.HEALTH_PATH | startswith("/") | not)) then "vars.HEALTH_PATH must start with /" else empty end),
    (if ($v | has("DATA_PATH")) and (($v.DATA_PATH | isstr | not) or ($v.DATA_PATH | test("^/[^ ]*[^/ ]$") | not)) then "vars.DATA_PATH must be an absolute path without a trailing slash" else empty end),
    (("HOST", "FAMILY_HOST") as $k
      | if ($v | has($k)) and ($v[$k] | lbl | not) then "vars.\($k) must be a lowercase DNS label" else empty end),
    (if ($v | has("IMAGE")) and (($v.IMAGE | isstr | not) or ($v.IMAGE | test("^[a-z0-9][a-z0-9./_:-]*$") | not)) then "vars.IMAGE is not an image name" else empty end),
    # dashboard tile: Flux substitutes after kustomize has re-serialized the route, so any quotes
    # around ${TITLE} are gone and the value must read as a plain one-line YAML string (go-yaml,
    # YAML 1.1: yes/no/on/off/y/n are booleans). Start with a letter, a small character set, no
    # trailing space, and never a YAML 1.1 boolean or null word.
    (("TITLE", "DESCRIPTION") as $k
      | if ($v | has($k)) and (($v[$k] | isstr | not) or ($v[$k] | test("^[A-Za-z]([A-Za-z0-9 .,()'&/+!?-]{0,78}[A-Za-z0-9.)!?])?$") | not) or ($v[$k] | yamlword)) then "vars.\($k) must start with a letter, use only letters, digits, spaces and .,()'&/+!?- (at most 80), and not be a YAML boolean or null word" else empty end),
    (if ($v | has("ICON")) and (($v.ICON | isstr | not) or ($v.ICON | test("^((mdi|si|sh)-[a-z0-9]+(-[a-z0-9]+)*|[a-z0-9][a-z0-9._-]*[.](png|svg|webp))$") | not)) then "vars.ICON must be mdi-<name>, si-<name>, sh-<name> or <name>.png/.svg/.webp" else empty end),
    # backup
    (if ($parts | index("backup")) != null and (($v.VOLSYNC_SCHEDULE | cron) | not) then "backup needs vars.VOLSYNC_SCHEDULE, an explicit UTC cron string" else empty end),
    (if ($parts | index("backup-sqlite")) != null then
       (if ($v.SQLITE_SCHEDULE | cron | not) then "backup-sqlite needs vars.SQLITE_SCHEDULE, an explicit UTC cron string" else empty end),
       (if ($v.SQLITE_DBS | isstr | not) or $v.SQLITE_DBS == "" or ($v.SQLITE_DBS | test("(^| )/|\\.\\.")) then "backup-sqlite needs vars.SQLITE_DBS: space-separated paths relative to the volume, without .." else empty end)
     else empty end),
    # scheduled job
    ((($parts | index("job")) != null) as $job
    | (($parts | index("job-egress")) != null) as $jobegress
    | (($v | keys)[] | select(startswith("JOB_")) | select($job | not) | "vars.\(.) needs the job part"),
      (if ($v | has("JOB_EGRESS_CIDR")) and ($jobegress | not) then "vars.JOB_EGRESS_CIDR needs the job-egress part" else empty end),
      (if $job and ($v | has("JOB_SCHEDULE") | not) then "job needs vars.JOB_SCHEDULE, an explicit UTC cron string"
       elif ($v | has("JOB_SCHEDULE")) and (($v.JOB_SCHEDULE | cron | not) or ($v.JOB_SCHEDULE | test("^[0-9][0-9,/-]*( [0-9A-Za-z*,/-]+){4}$") | not)) then "vars.JOB_SCHEDULE must be a UTC cron string of five fields that starts with a digit (Flux drops the quotes, and YAML reads a leading * as an alias: write 0-59/15, not */15)"
       elif ($v | has("JOB_SCHEDULE")) and ($v.JOB_SCHEDULE | cronranges | not) then "vars.JOB_SCHEDULE \($v.JOB_SCHEDULE) has a field out of range (minute 0-59, hour 0-23, day 1-31, month 1-12 or JAN-DEC, weekday 0-6 or SUN-SAT, steps from 1)"
       else empty end),
      (if $job and ($v | has("JOB_COMMAND") | not) then "job needs vars.JOB_COMMAND, the command to run from the app's image"
       elif ($v | has("JOB_COMMAND")) and (($v.JOB_COMMAND | isstr | not) or ($v.JOB_COMMAND | test("^[A-Za-z0-9 ./_=:-]{1,200}$") | not) or ($v.JOB_COMMAND | test("^ *$"))) then "vars.JOB_COMMAND may hold only letters, digits, spaces and ./_=:- (at most 200 characters): it runs under sh -c"
       elif ($v | has("JOB_COMMAND")) and ($v.JOB_COMMAND | test(":( |$)")) then "vars.JOB_COMMAND must not have a colon before a space or at the end (after substitution YAML would read it as a map)"
       else empty end),
      (("JOB_READ_PATH", "JOB_WORK_PATH") as $k
        | if $job and ($v | has($k) | not) then "job needs vars.\($k), a folder relative to the volume root"
          elif ($v | has($k)) and ($v[$k] | jobpath | not) then "vars.\($k) must be a relative path that starts with a letter, without .. or hidden segments, and not a YAML boolean or null word"
          else empty end),
      (if ($v.JOB_READ_PATH | jobpath) and ($v.JOB_WORK_PATH | jobpath)
          and ($v.JOB_READ_PATH == $v.JOB_WORK_PATH or ($v.JOB_WORK_PATH | startswith($v.JOB_READ_PATH + "/")) or ($v.JOB_READ_PATH | startswith($v.JOB_WORK_PATH + "/")))
       then "vars.JOB_READ_PATH \($v.JOB_READ_PATH) and vars.JOB_WORK_PATH \($v.JOB_WORK_PATH) must not equal or contain each other (the read mount is read only)" else empty end),
      (if ($v | has("JOB_MEMORY_LIMIT")) and ($v.JOB_MEMORY_LIMIT | qty) and ($v.JOB_MEMORY_LIMIT | qtybytes) < ("64Mi" | qtybytes) then "vars.JOB_MEMORY_LIMIT must be at least 64Mi, the job container's memory request (components/app-platform/job/cronjob.yaml)" else empty end),
      (if ($v | has("JOB_DEADLINE")) and (($v.JOB_DEADLINE | tostring | test("^[1-9][0-9]{0,4}$") | not) or ($v.JOB_DEADLINE | tostring | tonumber) > 86400) then "vars.JOB_DEADLINE must be a whole number of seconds from 1 to 86400" else empty end),
      (if $jobegress then
         (if ($job | not) then "job-egress needs the job part (its policy selects the job pods)" else empty end),
         (if $d.netpol == false then "job-egress has no meaning with netpol: false" else empty end),
         (if ($v | has("JOB_EGRESS_CIDR") | not) then "job-egress needs vars.JOB_EGRESS_CIDR, a public IPv4 CIDR from /16 to /32" else empty end)
       else empty end),
      (if ($v | has("JOB_EGRESS_CIDR")) then
         (if ($v.JOB_EGRESS_CIDR | cidr4 | not) then "vars.JOB_EGRESS_CIDR must be an IPv4 CIDR a.b.c.d/n with a prefix from /16 to /32"
          elif ($v.JOB_EGRESS_CIDR | hostbitszero | not) then "vars.JOB_EGRESS_CIDR \($v.JOB_EGRESS_CIDR) has host bits set (write the network address of the range)"
          else
            ($v.JOB_EGRESS_CIDR) as $c
            | [notpublic[] | select(. as $r | $c | overlaps($r))]
            | if length > 0 then "vars.JOB_EGRESS_CIDR \($c) is not public: it overlaps \(join(", "))" else empty end
          end)
       else empty end)),
    # path
    (if ($d | has("path")) then
       (if ($d.path | isstr | not) then "path must be a string"
        elif ($d.path | endswith("/")) then "path must not end with a slash"
        elif ($d.path | IN($base, "./kubernetes/apps/personal-apps/\($ns)/app", "./kubernetes/apps/personal-apps/\($name)/app")) then empty
        elif $fx and ($d.path | test("^\\./scripts/validate-apps/fixtures/custom/[a-z0-9-]+$")) then empty
        else "path must be the default base or ./kubernetes/apps/personal-apps/\($ns)/app" end)
     else empty end)
  ]
| .[]
JQ

# --- 4-6. Rendered output ----------------------------------------------------

# Pod specs of a built manifest stream (slurped). Checks the restricted fields,
# the read-only root filesystem, no service-account token, no Secret reference
# and, when $ns is not empty, the namespace. With $mapkit, the Deployment $app
# may carry the mapkit part's one reference, and only that: the env entry
# MAPKIT_TOKEN in container app, exactly
# {secretKeyRef: {name: <app>-mapkit, key: MAPKIT_TOKEN, optional: true}}.
read -r -d '' pods_jq <<'JQ' || true
def containers: ((.initContainers // []) + (.containers // []) + (.ephemeralContainers // []));
def mapkitref($app): . as $e
  | $e.name == "MAPKIT_TOKEN"
    and ($e | keys) == ["name", "valueFrom"]
    and $e.valueFrom == {secretKeyRef: {name: "\($app)-mapkit", key: $e.name, optional: true}};
def scannable($p; $s): if $mapkit and $p.kind == "Deployment" and $p.name == $app
  then $s | .containers |= map(if .name == "app" then .env |= ((. // []) | map(select(mapkitref($app) | not))) else . end)
  else $s end;
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
      (scannable($p; $s) | [.. | objects | keys[] | select(IN("valueFrom", "secretKeyRef", "secretRef"))] | unique | .[] | "\($id): \(.) is forbidden (apps receive no Secrets, env values are plain; the mapkit part allows only its MAPKIT_TOKEN reference)"),
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
def claude_proxy_rule: {toEndpoints: [{matchLabels: {"io.kubernetes.pod.namespace": "claude-proxy", "app.kubernetes.io/name": "claude-proxy"}}],
   toPorts: port3000};
def internet_except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "192.0.0.0/24", "198.18.0.0/15", "224.0.0.0/3"];
# job-egress: the job pods only, 443/TCP to the one CIDR, nothing inbound, and
# denied the own namespace and claude-proxy (a deny wins over the namespace
# policy's allow rules for these pods).
def expected_job_spec: {endpointSelector: {matchLabels: {"app.kubernetes.io/name": "\($name)-job"}},
  egress: [{toCIDR: [$jobcidr], toPorts: [{ports: [{port: "443", protocol: "TCP"}]}]}],
  egressDeny: [{toEndpoints: [{matchLabels: {"io.kubernetes.pod.namespace": $ns}}]},
               {toEndpoints: [{matchLabels: {"io.kubernetes.pod.namespace": "claude-proxy"}}]}]};
# share: a second policy that admits the cloudflared pods of the namespace
# <name>-share to the app pod on 3001/TCP, and nothing else (no egress, no
# other port).
def expected_share_spec: {endpointSelector: {matchLabels: {"app.kubernetes.io/name": $name}},
  ingress: [{fromEndpoints: [{matchLabels: {"io.kubernetes.pod.namespace": "\($name)-share", "app.kubernetes.io/name": "cloudflared"}}],
             toPorts: [{ports: [{port: "3001", protocol: "TCP"}]}]}]};
# share-admin: a second policy for the app pod only, egress to the share-admin
# pods on 8080/TCP and nothing else (no ingress, no other port).
def expected_share_admin_spec: {endpointSelector: {matchLabels: {"app.kubernetes.io/name": $name}},
  egress: [{toEndpoints: [{matchLabels: {"io.kubernetes.pod.namespace": "share-admin", "app.kubernetes.io/name": "share-admin"}}],
            toPorts: [{ports: [{port: "8080", protocol: "TCP"}]}]}]};
# The labels of every pod template, by workload (the kinds pods_jq checks).
def podlabels:
  .[] | select(type == "object" and .kind != null)
  | if .kind == "Pod" then {id: "Pod/\(.metadata.name)", labels: (.metadata.labels // {})}
    elif (.kind | IN("Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job")) then {id: "\(.kind)/\(.metadata.name)", labels: (.spec.template.metadata.labels // {})}
    elif .kind == "CronJob" then {id: "CronJob/\(.metadata.name)", labels: (.spec.jobTemplate.spec.template.metadata.labels // {})}
    else empty end;
. as $all
| [.[] | select(type == "object" and (.kind | IN("CiliumNetworkPolicy", "CiliumClusterwideNetworkPolicy", "NetworkPolicy")))] as $pols
| (if $jobegress then [$pols[] | select(.metadata.name == "\($name)-job")] else [] end) as $jobpols
| [$pols[] | select(.metadata.name == "\($name)-share")] as $sharepols
| [$pols[] | select(.metadata.name == "\($name)-share-admin")] as $sapols
| [.[] | select(type == "object" and .kind == "Service")] as $svcs
| [.[] | select(type == "object" and .kind == "Deployment" and .metadata.name == $name) | .spec.template.spec.containers[] | select(.name == "app")][0] as $appc
| (1 + (if $jobegress then 1 else 0 end) + (if $share then 1 else 0 end) + (if $shareadmin then 1 else 0 end)) as $npols
| [.[] | select(type == "object" and .kind == "HTTPRoute")] as $routes
| [.[] | select(type == "object" and .kind == "BackendTrafficPolicy")] as $btps
| [
    # Network policy: the namespace policy, plus the job's own with job-egress.
    (if $netpol | not then
       (if ($pols | length) > 0 then "netpol: false must render no network policy" else empty end)
     elif ($jobegress | not) and ($share | not) and ($shareadmin | not) and ($pols | length) != 1 then "expected exactly one CiliumNetworkPolicy, found \($pols | length)"
     elif ($jobegress or $share or $shareadmin) and (($pols | length) != $npols or ($jobpols | length) != (if $jobegress then 1 else 0 end) or ($sharepols | length) != (if $share then 1 else 0 end) or ($sapols | length) != (if $shareadmin then 1 else 0 end)) then "with job-egress, share or share-admin, expected exactly \($npols) CiliumNetworkPolicies, \($name)\(if $jobegress then " and \($name)-job" else "" end)\(if $share then " and \($name)-share" else "" end)\(if $shareadmin then " and \($name)-share-admin" else "" end), found \($pols | length): \([$pols[] | .metadata.name] | join(", "))"
     elif ($jobegress | not) and ($sharepols | length) != (if $share then 1 else 0 end) then "a policy \($name)-share without the share part"
     elif ($shareadmin | not) and ($sapols | length) != 0 then "a policy \($name)-share-admin without the share-admin part"
     else
       ($pols - $jobpols - $sharepols - $sapols)[0] as $p
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
          elif $egress == "claude-proxy" then
            (if $p.spec.egress != expected_egress + [claude_proxy_rule] then "egress must be the own-namespace rule, kube-dns on 53, then the claude-proxy pods on 3000/TCP" else empty end)
          elif $p.spec.egress != expected_egress then "egress is not: own namespace, kube-dns on 53 UDP and TCP"
          else empty end),
         (if $jobegress then
            $jobpols[0] as $j
            | (if $j.kind != "CiliumNetworkPolicy" or $j.metadata.namespace != $ns then "the job policy must be a CiliumNetworkPolicy named \($name)-job in \($ns)" else empty end),
              (if $j.spec != expected_job_spec then "the job policy \($name)-job must be exactly: endpointSelector app.kubernetes.io/name=\($name)-job, egress to \($jobcidr) on 443/TCP only, egressDeny to the namespace \($ns) and to the namespace claude-proxy, and no ingress" else empty end)
          else empty end),
         (if $share then
            $sharepols[0] as $s
            | (if $s.kind != "CiliumNetworkPolicy" or $s.metadata.namespace != $ns then "the share policy must be a CiliumNetworkPolicy named \($name)-share in \($ns)" else empty end),
              (if $s.spec != expected_share_spec then "the share policy \($name)-share must be exactly: endpointSelector app.kubernetes.io/name=\($name), ingress from the pods app.kubernetes.io/name=cloudflared in the namespace \($name)-share on 3001/TCP only, and no egress" else empty end)
          else empty end),
         (if $shareadmin then
            $sapols[0] as $a
            | (if $a.kind != "CiliumNetworkPolicy" or $a.metadata.namespace != $ns then "the share-admin policy must be a CiliumNetworkPolicy named \($name)-share-admin in \($ns)" else empty end),
              (if $a.spec != expected_share_admin_spec then "the share-admin policy \($name)-share-admin must be exactly: endpointSelector app.kubernetes.io/name=\($name), egress to the pods app.kubernetes.io/name=share-admin in the namespace share-admin on 8080/TCP only, and no ingress" else empty end)
          else empty end),
         ($pols[] | select(tojson | test("\"world\"|kube-apiserver|toEntities|toFQDNs")) | "the policy \(.metadata.name) has a world, kube-apiserver, toEntities or toFQDNs rule")
     end),
    # The job pod label is what the job-egress policy selects: only the job's
    # CronJob may carry it, and with `job` that CronJob carries it.
    ([$all | podlabels | select(.labels["app.kubernetes.io/name"] == "\($name)-job" and .id != "CronJob/\($name)-job")][]
      | "\(.id) carries the label app.kubernetes.io/name=\($name)-job, which only the CronJob \($name)-job may carry (the job-egress policy selects it)"),
    (if ($parts | index("job")) != null then
       ([$all | podlabels | select(.id == "CronJob/\($name)-job")]
        | if length != 1 then "job renders no CronJob \($name)-job"
          elif .[0].labels["app.kubernetes.io/name"] != "\($name)-job" then "CronJob \($name)-job: the pod label app.kubernetes.io/name must be \($name)-job"
          else empty end)
     else empty end),
    # share: the Service exposes only the guest port, the container port and the
    # three GUEST_ variables are exactly the part's, and without the part none of
    # them exists. The main port is named by no Service other than the app's own.
    (if $share then
       ($svcs | map(select(.metadata.name == "\($name)-share"))
        | if length != 1 then "share renders no Service \($name)-share"
          else .[0] as $s
            | (if $s.spec.ports != [{name: "guest", port: 3001, targetPort: "guest"}] or $s.spec.selector != {"app.kubernetes.io/name": $name} or ($s.spec.type // "ClusterIP") != "ClusterIP" then "the Service \($name)-share must be a ClusterIP Service that exposes only port 3001 (targetPort guest) of the app pod" else empty end)
          end),
       (if ([$appc.ports[]? | select(.name == "guest")]) != [{name: "guest", containerPort: 3001}] then "share must give container app of Deployment \($name) exactly the port guest (3001)" else empty end),
       (if ([$appc.env[]? | select(.name | startswith("GUEST_"))] | sort_by(.name)) != [{name: "GUEST_COLLECTIONS", value: $guestcols}, {name: "GUEST_HOSTS", value: "\($sharehost).\($domain)"}, {name: "GUEST_PORT", value: "3001"}] then "share must give container app of Deployment \($name) exactly GUEST_COLLECTIONS=\($guestcols), GUEST_HOSTS=\($sharehost).<zone> and GUEST_PORT=3001" else empty end)
     else
       (if ($svcs | any(.metadata.name == "\($name)-share")) then "a Service \($name)-share without the share part" else empty end),
       (if ([$appc.env[]? | select(.name | startswith("GUEST_"))] | length) > 0 or ([$appc.ports[]? | select(.containerPort == 3001)] | length) > 0 then "GUEST_ variables or port 3001 on the app container without the share part" else empty end)
     end),
    # share-admin: SHARE_ADMIN_URL on the app container is exactly the part's fixed address, and without the part there is none.
    (if $shareadmin then
       (if ([$appc.env[]? | select(.name == "SHARE_ADMIN_URL")]) != [{name: "SHARE_ADMIN_URL", value: "http://share-admin.share-admin.svc.cluster.local:8080"}] then "share-admin must give container app of Deployment \($name) exactly SHARE_ADMIN_URL=http://share-admin.share-admin.svc.cluster.local:8080" else empty end)
     else
       (if ([$appc.env[]? | select(.name == "SHARE_ADMIN_URL")] | length) > 0 then "SHARE_ADMIN_URL on the app container without the share-admin part" else empty end)
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
    yq -o=json -N '.' "$tmp/custom.yaml" | jq -s -r --arg ns "" --argjson pull '["apps-ghcr"]' --argjson mapkit false --arg app "" "$pods_jq" >"$tmp/custom.errs"
    [[ ! -s "$tmp/custom.errs" ]] || fail "custom path $dir: $(tr '\n' ';' <"$tmp/custom.errs")"
    echo "    custom path $dir: plain workload kinds, no credentials"
}

# The mapkit part's Secret: one Opaque Secret <name>-mapkit with exactly the
# key MAPKIT_TOKEN (a MapKit JS token, never a signing key), SOPS-encrypted
# under stringData, and sops metadata
# that matches the .sops.yaml rule for its path (the recipient, the regex, a
# MAC). cluster-apps decrypts it, and a file it cannot decrypt would stop the
# whole cluster-apps build, so a stand-in or a file for another key fails here.
# Only metadata and the shape are read, never a value. The owner makes it from
# 1Password with the pipeline in the personal-apps README; an agent never
# writes it.
mapkit_rule() {
    # The first creation rule that matches the Secret's path, as sops picks it.
    yq -o=json -I=0 '[.creation_rules[] | select(.path_regex as $r | "kubernetes/apps/personal-apps/x/mapkit.sops.yaml" | test($r))][0]' .sops.yaml
}

check_mapkit_secret() {
    local f="$1" name="$2" ns="$3" rule
    [[ -f "$f" ]] || fail "$f is missing: the owner creates it from 1Password (see 'Apple Maps (the mapkit part)' in kubernetes/apps/personal-apps/README.md). Never write it by hand"
    [[ "$(yq ea '[.] | length' "$f")" == "1" ]] || fail "$f must hold exactly one document"
    [[ "$(yq '.apiVersion' "$f")" == "v1" && "$(yq '.kind' "$f")" == "Secret" && "$(yq '.metadata.name' "$f")" == "$name-mapkit" && "$(yq '.type' "$f")" == "Opaque" ]] \
        || fail "$f must be an Opaque v1 Secret named $name-mapkit"
    [[ "$(yq ".metadata.namespace // \"$ns\"" "$f")" == "$ns" ]] || fail "$f: the namespace must be $ns"
    [[ "$(yq -o=json -I=0 '.stringData // {} | keys | sort' "$f")" == '["MAPKIT_TOKEN"]' ]] \
        || fail "$f: stringData must hold exactly MAPKIT_TOKEN (the signed token; the private key never enters the cluster)"
    [[ "$(yq '[.stringData[] | test("^ENC\\[")] | all' "$f")" == "true" ]] || fail "$f: a stringData value is not SOPS-encrypted"
    [[ "$(yq '.data // {} | length' "$f")" == "0" ]] || fail "$f has a data field; use stringData (flux build ks cannot mask an encrypted data value)"
    yq -e '.sops.age' "$f" >/dev/null 2>&1 || fail "$f has no sops metadata (not encrypted)"
    rule="$(mapkit_rule)"
    [[ "$rule" != "null" && -n "$rule" ]] || fail ".sops.yaml has no creation rule for kubernetes/apps/personal-apps/"
    yq -o=json -I=0 '.sops' "$f" | jq -e --argjson rule "$rule" '
        ((keys - ["age", "encrypted_regex", "lastmodified", "mac", "mac_only_encrypted", "version"]) == [])
        and (.age | length) == 1
        and .age[0].recipient == $rule.age
        and (.age[0].enc | test("^-----BEGIN AGE ENCRYPTED FILE-----\n[A-Za-z0-9+/=\n]+-----END AGE ENCRYPTED FILE-----\n?$"))
        and .encrypted_regex == $rule.encrypted_regex
        and (.mac_only_encrypted // false) == ($rule.mac_only_encrypted // false)
        and (.mac | type == "string" and test("^ENC\\[AES256_GCM,data:"))
        and (.lastmodified | type == "string" and length > 0)' >/dev/null \
        || fail "$f: its sops metadata does not match the .sops.yaml rule for kubernetes/ (one age recipient $(echo "$rule" | jq -r .age), encrypted_regex, mac_only_encrypted, an encrypted MAC); encrypt it with sops and the repo's .sops.yaml"
    echo "    mapkit: $f is an encrypted Secret $name-mapkit with MAPKIT_TOKEN, for the repo's age recipient"
}

# The share part's cloudflared, compared with the design: the routing file has
# exactly the guest host to the guest Service on 3001 with cloudflared's own
# Access check required, then a 404; and its policy allows only cluster DNS,
# the app pod on 3001, the tunnel (7844) and 443 to public ranges, and admits
# only the kubelet probe. $1 is the folder <name>-share/app.
check_share_files() {
    local dir="$1" name="$2" host="$3" f
    f="$dir/resources/cloudflared.yaml"
    [[ -f "$f" ]] || fail "the share part needs $f"
    yq -o=json -N '.' "$f" | jq -e --arg host "$host" --arg name "$name" '
        (keys == ["credentials-file", "ingress", "tunnel"])
        and .tunnel == "${SECRET_SHARE_TUNNEL_ID}"
        and ."credentials-file" == "/etc/cloudflared/credentials/credentials.json"
        and .ingress == [
          {hostname: "\($host).${SECRET_DOMAIN}",
           service: "http://\($name)-share.\($name).svc.cluster.local:3001",
           originRequest: {access: {required: true, teamName: "${SECRET_SHARE_ACCESS_TEAM}", audTag: ["${SECRET_SHARE_ACCESS_AUD}"]}}},
          {service: "http_status:404"}]' >/dev/null \
        || fail "$f must have only the keys tunnel, credentials-file and ingress; ingress rule 0 must be hostname $host.\${SECRET_DOMAIN} to http://$name-share.$name.svc.cluster.local:3001 with originRequest.access {required: true, teamName: \${SECRET_SHARE_ACCESS_TEAM}, audTag: [\${SECRET_SHARE_ACCESS_AUD}]} and nothing else, and rule 1 must be http_status:404 (the vars.SHARE_HOST of the entry must match the hostname)"
    f="$dir/networkpolicy.yaml"
    [[ -f "$f" ]] || fail "the share part needs $f"
    yq -o=json -N '.' "$f" | jq -e --arg name "$name" '
        def private: test("^(0|10|127)\\.|^192\\.168\\.|^172\\.(1[6-9]|2[0-9]|3[01])\\.|^100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.|^169\\.254\\.|^22[4-9]\\.|^2[3-5][0-9]\\.");
        . as $p
        | ($p.spec.egress | length) == 4
        and $p.apiVersion == "cilium.io/v2" and $p.kind == "CiliumNetworkPolicy" and $p.metadata == {name: "cloudflared"}
        and ($p.spec | keys) == ["egress", "endpointSelector", "ingress"]
        and $p.spec.endpointSelector == {}
        and $p.spec.ingress == [{fromEntities: ["host"], toPorts: [{ports: [{port: "2000", protocol: "TCP"}]}]}]
        and $p.spec.egress[0] == {toEndpoints: [{matchLabels: {"io.kubernetes.pod.namespace": "kube-system", "k8s-app": "kube-dns"}}], toPorts: [{ports: [{port: "53", protocol: "UDP"}, {port: "53", protocol: "TCP"}]}]}
        and $p.spec.egress[1] == {toEndpoints: [{matchLabels: {"io.kubernetes.pod.namespace": $name, "app.kubernetes.io/name": $name}}], toPorts: [{ports: [{port: "3001", protocol: "TCP"}]}]}
        and $p.spec.egress[2] == {toCIDRSet: [{cidr: "198.41.192.0/24"}, {cidr: "198.41.200.0/24"}], toPorts: [{ports: [{port: "7844", protocol: "TCP"}, {port: "7844", protocol: "UDP"}]}]}
        and ($p.spec.egress[3] | keys) == ["toCIDRSet", "toPorts"]
        and $p.spec.egress[3].toPorts == [{ports: [{port: "443", protocol: "TCP"}]}]
        and ($p.spec.egress[3].toCIDRSet | length) > 0
        and ($p.spec.egress[3].toCIDRSet | all(keys == ["cidr"] and (.cidr | test("^[0-9.]+/[0-9]+$")) and (.cidr | private | not) and ((.cidr | split("/")[1] | tonumber) >= 12)))' >/dev/null \
        || fail "$f must be exactly: ingress only the kubelet probe on 2000/TCP; egress only cluster DNS, the pods app.kubernetes.io/name=$name in the namespace $name on 3001/TCP (never 3000), the tunnel edge 198.41.192.0/24 and 198.41.200.0/24 on 7844 TCP and UDP, and 443/TCP to public IPv4 ranges (/12 or smaller, none private)"
    echo "    share: $dir routes only the guest host to $name-share:3001 with the Access check required, and its policy reaches nothing else"
}

validate_entry() {
    local file="$1" stem fx=false errs name ns path parts_json pull_json host famhost netpol egress
    local jobegress jobcidr sub_ok count secret_pull n nsdir nsroot mapkit listed other share sharehost guestcols shareadmin
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
    jobegress="$(echo "$parts_json" | jq 'index("job-egress") != null')"
    jobcidr="$(yq '.spec.defaultValues.vars.JOB_EGRESS_CIDR // ""' "$file")"
    share="$(echo "$parts_json" | jq 'index("share") != null')"
    shareadmin="$(echo "$parts_json" | jq 'index("share-admin") != null')"
    sharehost="$(yq '.spec.defaultValues.vars.SHARE_HOST // ""' "$file")"
    guestcols="$(yq '.spec.defaultValues.vars.GUEST_COLLECTIONS // ""' "$file")"
    pull_json="$(yq -o=json -I=0 '["apps-ghcr", (.spec.defaultValues.vars.PULL_SECRET // "apps-ghcr")]' "$file")"

    if [[ "$netpol" == "false" ]]; then
        echo "    NETWORK POLICY OFF for $name: $(yq '.spec.defaultValues.netpolReason' "$file")"
    fi

    # 8. The Namespace folder (Git-defined, same PR as the entry). For a fixture
    # the self-test makes a folder per sample under a temporary root.
    nsroot="kubernetes/apps/personal-apps"
    if [[ "$fx" == true && -n "${VALIDATE_APPS_NS_ROOT:-}" ]]; then nsroot="$VALIDATE_APPS_NS_ROOT"; fi
    nsdir="$nsroot/$ns"
    [[ -f "$nsdir/kustomization.yaml" ]] \
        || fail "the Namespace folder $nsdir/kustomization.yaml is missing; add it (and its line in $nsroot/kustomization.yaml) in the same PR"
    [[ "$(yq '.namespace' "$nsdir/kustomization.yaml")" == "$ns" ]] \
        || fail "$nsdir/kustomization.yaml: namespace must be $ns"
    yq -e '.components[] | select(. == "../../../components/personal-namespace")' "$nsdir/kustomization.yaml" >/dev/null 2>&1 \
        || fail "$nsdir/kustomization.yaml must use ../../../components/personal-namespace"
    yq -e ".resources[] | select(. == \"./$ns\")" "$nsroot/kustomization.yaml" >/dev/null 2>&1 \
        || fail "$nsroot/kustomization.yaml does not list ./$ns"
    # 8b. The share part's cloudflared lives outside the platform, in the
    # Namespace $name-share (the part's policy admits cloudflared from there):
    # its folder must exist, listed, with the Flux Kustomization that applies it.
    if [[ "$share" == true ]]; then
        [[ -f "$nsroot/$name-share/kustomization.yaml" ]] \
            || fail "the share part needs the folder $nsroot/$name-share/ (cloudflared in the Namespace $name-share); add it in the same PR"
        yq -e ".resources[] | select(. == \"./$name-share\")" "$nsroot/kustomization.yaml" >/dev/null 2>&1 \
            || fail "$nsroot/kustomization.yaml does not list ./$name-share (the share part's cloudflared)"
        check_share_files "$nsroot/$name-share/app" "$name" "$sharehost"
    fi
    # 8a. The MapKit Secret, with the mapkit part only.
    mapkit="$(echo "$parts_json" | jq 'index("mapkit") != null')"
    listed="$(yq '[.resources // [] | .[] | select(. == "./mapkit.sops.yaml" or . == "mapkit.sops.yaml")] | length' "$nsdir/kustomization.yaml")"
    if [[ "$mapkit" == true ]]; then
        # The folder holds the Secret, and cluster-apps applies the folder as it
        # is, with no pod check: so it may hold nothing else that could read it.
        [[ "$(yq -o=json -I=0 'keys - ["apiVersion", "kind", "namespace", "components", "resources"]' "$nsdir/kustomization.yaml")" == "[]" ]] \
            || fail "$nsdir/kustomization.yaml: with the mapkit part it may set only apiVersion, kind, namespace, components and resources"
        [[ "$(yq -o=json -I=0 '.components' "$nsdir/kustomization.yaml")" == '["../../../components/personal-namespace"]' ]] \
            || fail "$nsdir/kustomization.yaml: with the mapkit part its only component is ../../../components/personal-namespace"
        [[ "$(yq -o=json -I=0 '.resources // []' "$nsdir/kustomization.yaml")" == '["./mapkit.sops.yaml"]' ]] \
            || fail "$nsdir/kustomization.yaml must list exactly ./mapkit.sops.yaml: with the mapkit part the folder holds the Namespace and the Secret $name-mapkit, nothing else"
        other="$(find "$nsdir" -mindepth 1 ! -name kustomization.yaml ! -name mapkit.sops.yaml ! -name .DS_Store -print -quit)"
        [[ -z "$other" ]] || fail "$nsdir holds $other: with the mapkit part the folder holds only kustomization.yaml and mapkit.sops.yaml"
        check_mapkit_secret "$nsdir/mapkit.sops.yaml" "$name" "$ns"
    else
        [[ "$listed" == "0" && ! -e "$nsdir/mapkit.sops.yaml" ]] || fail "$nsdir holds mapkit.sops.yaml, but the entry has no mapkit part"
    fi

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
        ! grep -qF 'fluxcd.controlplane.io/force' "$tmp/rset-pull.yaml" || fail "the apps-pull render sets fluxcd.controlplane.io/force"
        # apps-pull also renders the fixed `inputs` (see spec.inputs); the checks below look at this entry's namespace, then the whole set
        sel='select(.kind == "Secret" and .metadata.namespace == "'"$ns"'")'
        n="$(yq -N "$sel | .metadata.name" "$tmp/rset-pull.yaml" | grep -c . || true)"
        [[ "$secret_pull" == true || "$n" == "0" ]] || fail "apps-pull rendered a Secret in $ns for an entry without the pullsecret part"
        if [[ "$secret_pull" == true ]]; then
            [[ "$n" == "1" \
                && "$(yq -N "$sel | .metadata.name" "$tmp/rset-pull.yaml")" == "apps-ghcr" \
                && "$(yq -N "$sel | .metadata.namespace" "$tmp/rset-pull.yaml")" == "$ns" \
                && "$(yq -N "$sel | .type" "$tmp/rset-pull.yaml")" == "kubernetes.io/dockerconfigjson" \
                && "$(yq -N "$sel | .metadata.annotations[\"fluxcd.controlplane.io/copyFrom\"]" "$tmp/rset-pull.yaml")" == "flux-system/ghcr-apps-read" \
                && "$(yq -N "$sel | .metadata.annotations[\"fluxcd.controlplane.io/prune\"]" "$tmp/rset-pull.yaml")" == "disabled" ]] \
                || fail "apps-pull must render one dockerconfigjson Secret apps-ghcr in $ns with copyFrom flux-system/ghcr-apps-read and prune: disabled"
        fi
        # The whole set: exactly the static inputs' namespaces plus this entry's own (a duplicate fails here).
        want="$( { yq -N '.spec.inputs[].name' "$rs_pull"; if [[ "$secret_pull" == true ]]; then echo "$ns"; fi; } | sed 's#^#Secret/#; s#$#/apps-ghcr#' | sort)"
        got="$(yq -N 'select(.kind == "Secret") | "Secret/" + .metadata.namespace + "/" + .metadata.name' "$tmp/rset-pull.yaml" | sort)"
        [[ "$got" == "$want" ]] || fail "apps-pull must render exactly these Secrets (static inputs plus this entry): $(echo $want) -- got: $(echo $got)"
    else
        # The CLI exits 1 when nothing renders; the controller accepts that.
        if [[ "$secret_pull" == true ]] || ! grep -q 'no objects were generated' "$tmp/rset.err"; then
            fail "flux-operator build rset (apps-pull) failed: $(cat "$tmp/rset.err")"
        fi
    fi

    # 4. Build the Kustomization as Flux would, with stand-in zones.
    yq ".spec.postBuild.substitute.SECRET_DOMAIN_LOCAL = \"$fake_local\" | .spec.postBuild.substitute.SECRET_FAMILY_DOMAIN = \"$fake_family\" | .spec.postBuild.substitute.SECRET_DOMAIN = \"$fake_domain\"" "$tmp/ks.yaml" >"$tmp/ks-build.yaml"
    flux build ks "app-$name" --namespace flux-system --dry-run --path "${path:-$base_path}" \
        --kustomization-file "$tmp/ks-build.yaml" >"$tmp/build.yaml" 2>"$tmp/build.err" \
        || fail "flux build ks failed: $(cat "$tmp/build.err")"
    conform <"$tmp/ks.yaml" >"$tmp/conform.out" 2>&1 || fail "kubeconform (rendered Kustomization): $(cat "$tmp/conform.out")"
    conform <"$tmp/build.yaml" >"$tmp/conform.out" 2>&1 || fail "kubeconform (built objects): $(cat "$tmp/conform.out")"
    ! grep -qF 'fluxcd.controlplane.io/force' "$tmp/build.yaml" || fail "the build sets fluxcd.controlplane.io/force"

    # 4-6. Restricted pods, no credentials, the network policy and the routes.
    yq -o=json -N '.' "$tmp/build.yaml" | jq -s '[.[] | select(type == "object")]' >"$tmp/build.json"
    # Fixtures only: `# mutate: <jq filter>` changes the built objects, so the
    # self-test can show that the checks below catch a broken part.
    if [[ "$fx" == true ]]; then
        errs="$(sed -n 's/^# mutate: //p' "$file")"
        if [[ -n "$errs" ]]; then
            jq "$errs" "$tmp/build.json" >"$tmp/build.mut" && mv "$tmp/build.mut" "$tmp/build.json"
        fi
    fi
    # A variable left in the build would be a typo. Only container env values
    # may hold a literal ${...}: that is what the documented $${...} escape in
    # `env` becomes after substitution.
    errs="$(jq -r '[.[] | walk(if type == "object" and has("env") then del(.env) else . end) | .. | strings | select(contains("${"))] | unique | join(" ")' "$tmp/build.json")"
    [[ -z "$errs" ]] || fail "the build has an unsubstituted \${...} outside container env: $errs"
    errs="$(jq -r --arg ns "$ns" --argjson pull "$pull_json" --argjson mapkit "$mapkit" --arg app "$name" "$pods_jq" "$tmp/build.json")"
    [[ -z "$errs" ]] || fail "pods: $(printf '%s\n' "$errs" | sed '2,$s/^/    /')"
    if [[ "$mapkit" == true ]]; then
        # The part's two env entries, on the app container of the app's Deployment.
        errs="$(jq -r --arg app "$name" --arg want "https://$host.$fake_local,https://$famhost.$fake_family,https://$sharehost.$fake_domain" '
            [.[] | select(.kind == "Deployment" and .metadata.name == $app) | .spec.template.spec.containers[] | select(.name == "app") | .env // [] | .[]] as $env
            | ([$env[] | select(.valueFrom.secretKeyRef.name == "\($app)-mapkit") | .name] | sort) as $refs
            | (if $refs != ["MAPKIT_TOKEN"] then "the mapkit part must give container app of Deployment \($app) exactly MAPKIT_TOKEN from \($app)-mapkit (got \($refs | join(", ")))" else empty end),
              (if [$env[] | select(.name == "MAPKIT_ORIGINS") | .value] != [$want] then "MAPKIT_ORIGINS must be \($want) (the route hosts)" else empty end)' "$tmp/build.json")"
        [[ -z "$errs" ]] || fail "mapkit: $errs"
    fi
    errs="$(jq -r --arg ns "$ns" --arg name "$name" --argjson netpol "$netpol" --arg egress "$egress" \
        --argjson parts "$parts_json" --arg host "$host" --arg famhost "$famhost" \
        --argjson jobegress "$jobegress" --arg jobcidr "$jobcidr" \
        --argjson share "$share" --argjson shareadmin "$shareadmin" --arg sharehost "$sharehost" --arg guestcols "$guestcols" --arg domain "$fake_domain" \
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
# A stand-in for the mapkit Secret, for the fixtures. It has the shape and the
# sops metadata of a real file for the repo's recipient, with placeholder
# ENC[...] values that hold nothing and are never decrypted. "plain" has a
# value without ENC[; "wrong-recipient" is for another age key.
write_mapkit_standin() {
    local f="$1" name="$2" kind="$3" enc='ENC[AES256_GCM,data:c3RhbmQtaW4=,iv:c3RhbmQtaW4=,tag:c3RhbmQtaW4=,type:str]' first rule recipient
    first="$enc"
    [[ "$kind" != "plain" ]] || first="not-encrypted"
    rule="$(mapkit_rule)"
    recipient="$(echo "$rule" | jq -r .age)"
    [[ "$kind" != "wrong-recipient" ]] || recipient="age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"
    printf -- '---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: %s-mapkit\ntype: Opaque\nstringData:\n  MAPKIT_TOKEN: %s\nsops:\n  age:\n    - enc: |\n        -----BEGIN AGE ENCRYPTED FILE-----\n        c3RhbmQtaW4=\n        -----END AGE ENCRYPTED FILE-----\n      recipient: %s\n  encrypted_regex: %s\n  lastmodified: "2026-01-01T00:00:00Z"\n  mac: %s\n  mac_only_encrypted: %s\n  version: 3.13.3\n' \
        "$name" "$first" "$recipient" "$(echo "$rule" | jq -r .encrypted_regex)" "$enc" "$(echo "$rule" | jq -r '.mac_only_encrypted // false')" >"$f"
    if [[ "$kind" == "extra" ]]; then
        printf -- '---\napiVersion: v1\nkind: Pod\nmetadata:\n  name: reader\nspec:\n  containers:\n    - name: c\n      image: busybox\n      envFrom:\n        - secretRef:\n            name: %s-mapkit\n' "$name" >"$(dirname "$f")/reader.yaml"
    fi
}

run_self_test() {
    local f expect out rc passed=0 failed=0 nsroot="$tmp/fixture-ns" c root name mapkit_case
    # An entry lives in the namespace of its own name, so each sample gets a
    # Namespace folder of that name under a temporary root (a sample marked
    # `# no-namespace-folder` gets none).
    mkdir -p "$nsroot"
    printf -- '---\napiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources: []\n' >"$nsroot/kustomization.yaml"
    for f in "$fixtures_dir"/pass/*.yaml "$fixtures_dir"/fail/*.yaml; do
        [[ -f "$f" ]] || continue
        if grep -q '^# no-namespace-folder' "$f"; then continue; fi
        name="$(yq '.spec.defaultValues.name' "$f")"
        mkdir -p "$nsroot/$name"
        printf -- '---\napiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nnamespace: %s\ncomponents:\n  - ../../../components/personal-namespace\n' "$name" >"$nsroot/$name/kustomization.yaml"
        yq -i ".resources += [\"./$name\"]" "$nsroot/kustomization.yaml"
        # A sample with the share part gets the cloudflared folder too, unless it
        # says `# no-share-folder`.
        if yq -e '.spec.defaultValues.parts[] | select(. == "share")' "$f" >/dev/null 2>&1 && ! grep -q '^# no-share-folder' "$f"; then
            mkdir -p "$nsroot/$name-share/app/resources"
            printf -- '---\napiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources: []\n' >"$nsroot/$name-share/kustomization.yaml"
            yq -i ".resources += [\"./$name-share\"]" "$nsroot/kustomization.yaml"
            # cloudflared's routing and policy: the real files for this sample's
            # names, or with `# share-files: <case>` a broken copy.
            real="kubernetes/apps/personal-apps/reports-share/app"
            sh_host="$(yq '.spec.defaultValues.vars.SHARE_HOST' "$f")"
            sed "s#share\.\${SECRET_DOMAIN}#$sh_host.\${SECRET_DOMAIN}#; s#reports-share\.reports\.svc#$name-share.$name.svc#" "$real/resources/cloudflared.yaml" >"$nsroot/$name-share/app/resources/cloudflared.yaml"
            yq "(.spec.egress[] | select(.toEndpoints[0].matchLabels[\"app.kubernetes.io/name\"] == \"reports\") | .toEndpoints[0].matchLabels) |= (.[\"io.kubernetes.pod.namespace\"] = \"$name\" | .[\"app.kubernetes.io/name\"] = \"$name\")" "$real/networkpolicy.yaml" >"$nsroot/$name-share/app/networkpolicy.yaml"
            case "$(sed -n 's/^# share-files: //p' "$f")" in
                required-false) sed -i.bak 's/required: true/required: false/' "$nsroot/$name-share/app/resources/cloudflared.yaml" ;;
                extra-rule) yq -i '.ingress = [{"hostname": "x.example.test", "service": "http://x.x.svc.cluster.local:80"}] + .ingress' "$nsroot/$name-share/app/resources/cloudflared.yaml" ;;
                policy-3000) yq -i '(.spec.egress[] | select(.toEndpoints[0].matchLabels["app.kubernetes.io/name"] != null) | .toPorts[0].ports) += [{"port": "3000", "protocol": "TCP"}]' "$nsroot/$name-share/app/networkpolicy.yaml" ;;
            esac
        fi
        # `# mapkit-secret: <case>` gives the sample's folder a mapkit.sops.yaml
        # stand-in: its shape only, with placeholder ENC[...] values that hold
        # no secret and are never decrypted.
        mapkit_case="$(sed -n 's/^# mapkit-secret: //p' "$f")"
        if [[ -n "$mapkit_case" ]]; then
            [[ "$mapkit_case" == "listed-missing" ]] || write_mapkit_standin "$nsroot/$name/mapkit.sops.yaml" "$name" "$mapkit_case"
            [[ "$mapkit_case" == "unlisted" ]] || yq -i '.resources += ["./mapkit.sops.yaml"]' "$nsroot/$name/kustomization.yaml"
            [[ "$mapkit_case" != "extra" ]] || yq -i '.resources += ["./reader.yaml"]' "$nsroot/$name/kustomization.yaml"
        fi
    done
    export VALIDATE_APPS_NS_ROOT="$nsroot"
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
    # The folders the cluster-admin Kustomization applies: a copy of the real
    # platform folder with the entries removed, with each broken sample laid over
    # it (structure/<case>/overlay, resources to append in structure/<case>/append
    # as "<folder> <resource>" lines, the expected text in structure/<case>/expect).
    # Without overlay the copy itself must pass.
    for c in "" "$fixtures_dir"/structure/*/; do
        if [[ -n "$c" ]]; then
            [[ -d "$c" ]] || continue
            name="$(basename "$c")"
            expect="$(<"$c/expect")"
        else
            name="baseline"
            expect=""
        fi
        root="$tmp/structure/$name"
        mkdir -p "$root/$(dirname "$platform_dir")"
        cp -R "$platform_dir" "$root/$platform_dir"
        find "$root/$apps_dir" -type f ! -name kustomization.yaml -delete
        printf -- '---\napiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources: []\n' >"$root/$apps_dir/kustomization.yaml"
        if [[ -n "$c" ]]; then
            if [[ -d "$c/overlay" ]]; then cp -R "$c/overlay/." "$root/$platform_dir/"; fi
            if [[ -f "$c/append" ]]; then
                while read -r folder resource; do
                    [[ -n "$folder" ]] || continue
                    yq -i ".resources += [\"$resource\"]" "$root/$platform_dir/$folder/kustomization.yaml"
                done <"$c/append"
            fi
        fi
        rc=0
        out="$("$script_path" --structure "$root" 2>&1)" || rc=$?
        if [[ -z "$expect" ]] && ((rc == 0)); then
            echo "pass  structure/$name (the platform folder without entries)"
            passed=$((passed + 1))
        elif [[ -n "$expect" ]] && ((rc != 0)) && [[ "$out" == *"$expect"* ]]; then
            echo "reject structure/$name ($expect)"
            passed=$((passed + 1))
        else
            echo "FAIL  structure/$name (expected: ${expect:-valid}; exit $rc):" >&2
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
            --structure) mode=structure ;;
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
        structure) check_structure; return ;;
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
    check_structure
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
