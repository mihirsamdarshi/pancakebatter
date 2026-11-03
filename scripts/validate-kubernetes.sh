#!/usr/bin/env bash
# Validates the Flux manifests under kubernetes/ before Flux applies them.
#
#   validate-kubernetes.sh [ROOT]   validate ROOT/kubernetes (default: repo root)
#
# The Kubernetes workflow and `just template configure` both call this script,
# so local runs and CI cannot drift. It lives outside template/ because
# `just template tidy` archives that folder.
#
# Checks, all of which fail the run:
#   1. kubeconform on standalone manifests under kubernetes/flux (Flux reads
#      kubernetes/flux/cluster directly; it has no kustomization.yaml);
#   2. `kustomize build | kubeconform` for every kustomization.yaml under
#      kubernetes/flux and kubernetes/apps, and every Namespace it builds must
#      be named with a lowercase RFC 1123 label (the schemas do not check
#      names, and a Namespace that cannot be applied stops Flux applying the
#      rest of that Kustomization, e.g. an app that forgot `namespace:` and so
#      keeps the REPLACE_ME placeholder of components/personal-namespace);
#   3. kubeconform on every Flux Kustomization object, and
#      `flux build ks --dry-run | kubeconform` for each one sourced from this
#      repo, which also catches a wrong spec.path and broken spec.patches.
#      A GitRepository sourceRef must be exactly flux-system/flux-system with
#      an explicit namespace. An OCIRepository sourceRef cannot be built from
#      this repo, so it is logged as "skipped (external source)", but the
#      OCIRepository it names (namespace defaulting to the Kustomization's
#      metadata.namespace) must be declared in the tree. Any other source
#      kind fails;
#   4. no unclosed `${VAR` (a Flux postBuild substitution missing its `}`);
#   5. no `%` in an Envoy Gateway directResponse body (inline, or the ConfigMap
#      an HTTPRouteFilter's valueRef names);
#   6. no `${SECRET_DOMAIN}` outside an allowlist: it is the bare zone, and LAN
#      names use `${SECRET_DOMAIN_LOCAL}` (SECRET_DOMAIN meant local.<zone>
#      until October 26, 2026);
#   7. the personal app platform (scripts/validate-apps.sh): its registry
#      credential, every entry under flux-system/app-platform/apps, and what
#      the ResourceSets render from them. These Kustomizations are generated
#      at reconcile time, so none of the checks above can see them. It runs
#      first, so a missing ghcr-apps-read.sops.yaml is reported before
#      kustomize trips over the file the kustomization lists. A tree without
#      the app platform skips it;
#   8. the Flux Operator web UI keeps a fixed identity: the flux-operator
#      HelmRelease must set
#      spec.values.web.config.authentication.anonymous.username to flux-web-anon,
#      the user rbac.yaml binds, with no anonymous groups, unless
#      spec.values.web.enabled is false (no UI). Without a web config the UI
#      reads the cluster with the operator's own cluster-admin account for
#      every caller, and a values edit that drops the block is otherwise valid.
#      The same release must not set web.config.search.cached, FineGrained user
#      actions, valuesFrom or postRenderers, and neither its kustomization.yaml
#      nor its ks.yaml may carry patches: each bypasses or can replace that
#      identity. A tree without that file fails: the template always renders it.
#   9. every PrometheusRule under kubernetes/ passes `promtool check rules`, and
#      has unit tests that pass: scripts/validate-rules/<name>.test.yaml and any
#      <name>.<variant>.test.yaml, where <name> is the PrometheusRule's
#      metadata.name. The validator extracts its .spec to <name>.rules.yaml next
#      to a copy of each test file, so a test file lists `rule_files:
#      [<name>.rules.yaml]`. A rule without tests fails unless it is in the
#      exempt list in check_prometheus_rules (the app platform rule is tested by
#      validate-apps.sh). `promtool check rules` accepts an expression on a
#      metric that does not exist, so the tests feed series under the names and
#      labels the exporters really publish and expect the alerts to fire. Rules
#      rendered by a Helm chart are not files in this tree and are not covered.
#  10. every Alloy configuration embedded in a HelmRelease
#      (spec.values.alloy.configMap.content) passes `alloy validate` and
#      `alloy fmt`, which catch a syntax or argument error before Flux applies
#      it (a one-line block `rule { a = ... b = ... }` does not parse). It uses
#      an `alloy` binary if there is one, else the pinned image in the local
#      Docker cache (docker pull grafana/alloy:v1.21.1, 700 MB); with neither
#      it is skipped with a message, because CI does not carry Alloy.
# archive/ and other trees outside kubernetes/ are never read.
#
# Schemas fail closed: there is no -ignore-missing-schemas, so a typo in
# apiVersion or kind, or a CRD without a published schema, fails the run. Add a
# kind to the -skip list below only when no configured schema location has it.
#
# Known limit: each Flux Kustomization is built from its own file, so patches
# that a parent applies to it at reconcile time (cluster-apps injects sops
# decryption and HelmRelease install/upgrade defaults into every child) are not
# part of the child's build here.

set -euo pipefail

script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

kustomize_args=("--load-restrictor=LoadRestrictionsNone")
kubeconform_args=(
    "-strict"
    "-summary"
    # Secret: sops-encrypted Secrets carry a top-level `sops` key that -strict
    # rejects; the decrypted Secret only exists in-cluster.
    "-skip" "Secret"
    "-schema-location" "default"
    "-schema-location" "https://k8s-schemas.home-operations.com/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"
)

# kubeconform on stdin. Flux postBuild variables are filled in only at
# reconcile time, from cluster Secrets this script cannot read. So
# ${VAR:=default} and ${VAR:-default} become their default, and any other
# ${VAR...} (e.g. ${VAR/./-}) a DNS-label-safe stand-in. Otherwise every
# pattern-checked field holding one (an HTTPRoute or Gateway hostname, a
# Certificate dnsName) fails.
conform() {
    sed -E \
        -e 's/\$\{[A-Za-z_][A-Za-z0-9_]*:[-=]([^}]*)\}/\1/g' \
        -e 's/\$\{[A-Za-z_][^}]*\}/placeholder/g' \
        | kubeconform "${kubeconform_args[@]}"
}

# Envoy parses a directResponse body as a format string, where `%` starts a
# command operator. A stray one (a CSS width, "100%") makes Envoy reject the
# whole route configuration, so the Gateway keeps serving its previous config
# while the change looks applied. Checks every HTTPRouteFilter in a rendered
# manifest stream ($1, labelled $2): an inline body, or the ConfigMap named by
# its valueRef (key response.body, else the first key) matched by name within
# the same stream. A ConfigMap that is not in the stream cannot be checked, so
# that fails too.
check_direct_response_bodies() {
    local file="$1" label="$2" name bodies
    bodies="$(yq -N 'select(.kind == "HTTPRouteFilter" and .spec.directResponse.body.inline != null
        and (.spec.directResponse.body.inline | contains("%"))) | .metadata.name' "$file")"
    [[ -z "${bodies//[[:space:]]/}" ]] \
        || die "$label: HTTPRouteFilter directResponse body contains '%' (Envoy format string): ${bodies//$'\n'/ }"

    yq -N 'select(.kind == "HTTPRouteFilter" and .spec.directResponse.body.type == "ValueRef")
        | .spec.directResponse.body.valueRef.name' "$file" >"$tmp/dr-refs"
    while IFS= read -r name; do
        [[ -n "$name" ]] || continue
        NAME="$name" yq -N 'select(.kind == "ConfigMap" and .metadata.name == strenv(NAME))
            | .metadata.name' "$file" >"$tmp/dr-found"
        [[ -n "$(<"$tmp/dr-found")" ]] \
            || die "$label: HTTPRouteFilter directResponse body ConfigMap $name is not in the same build, so it cannot be checked for '%'"
        bodies="$(NAME="$name" yq -N 'select(.kind == "ConfigMap" and .metadata.name == strenv(NAME))
            | ((.data["response.body"] // (.data | to_entries | .[0].value) // "") | contains("%"))' "$file")"
        [[ "$bodies" != *true* ]] \
            || die "$label: ConfigMap $name (HTTPRouteFilter directResponse body) contains '%' (Envoy format string)"
    done <"$tmp/dr-refs"
}

# "namespace/name" of every Flux OCIRepository in a rendered manifest stream.
list_oci_repositories() {
    yq -N 'select(.apiVersion == "source.toolkit.fluxcd.io/*" and .kind == "OCIRepository")
        | (.metadata.namespace // "") + "/" + (.metadata.name // "")' "$1"
}

die() {
    echo "validate-kubernetes: $*" >&2
    exit 1
}

# Fail closed: a missing tool must fail the gate, never skip it.
require_tools() {
    local tool missing=()
    for tool in kubeconform kustomize flux yq git flux-operator jq gitleaks promtool; do
        command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
    done
    ((${#missing[@]} == 0)) || die "missing tools: ${missing[*]} (run via 'mise exec --' or 'mise install')"
}

# Schemas are cached between runs so the hook stays fast; CI starts empty.
setup_cache() {
    local cache="${KUBECONFORM_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/kubeconform}"
    mkdir -p "$cache"
    kubeconform_args+=("-cache" "$cache")
}

# Check 9: promtool check and unit tests for every PrometheusRule file.
# $1 is a scratch directory. Runs from the repository root.
check_prometheus_rules() {
    local tmp="$1" rules_dir="$1/rules" test_dir="scripts/validate-rules"
    # Rules with no unit tests yet. app-platform is tested by validate-apps.sh.
    local exempt=" app-platform certificates volsync "
    local file name t tests orphan
    mkdir -p "$rules_dir"
    find kubernetes -type f -name '*.yaml' ! -name kustomization.yaml ! -name '*.sops.yaml' -print0 \
        | sort -z >"$tmp/rule.files"
    : >"$tmp/rule.names"
    while IFS= read -r -d '' file; do
        yq -N 'select(.kind == "PrometheusRule") | .metadata.name' "$file" >"$tmp/rule.found"
        while IFS= read -r name; do
            [[ -n "$name" ]] || continue
            [[ "$name" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] \
                || die "$file: PrometheusRule name '$name' is not a lowercase RFC 1123 label"
            [[ ! -e "$rules_dir/$name.rules.yaml" ]] \
                || die "$file: a second PrometheusRule named $name (the unit tests are keyed by name)"
            NAME="$name" yq -N 'select(.kind == "PrometheusRule" and .metadata.name == strenv(NAME)) | .spec' "$file" \
                >"$rules_dir/$name.rules.yaml"
            promtool check rules "$rules_dir/$name.rules.yaml" >"$tmp/promtool.out" 2>&1 \
                || die "$file ($name): promtool check rules failed: $(cat "$tmp/promtool.out")"
            echo "$name" >>"$tmp/rule.names"
            echo "--- $file ($name): promtool check rules passes"
        done <"$tmp/rule.found"
    done <"$tmp/rule.files"

    shopt -s nullglob
    while IFS= read -r name; do
        tests=()
        for t in "$test_dir/$name".test.yaml "$test_dir/$name".*.test.yaml; do
            [[ -e "$t" ]] && tests+=("$t")
        done
        if ((${#tests[@]} == 0)); then
            [[ "$exempt" == *" $name "* ]] \
                || die "PrometheusRule $name has no unit tests: add $test_dir/$name.test.yaml with 'rule_files: [$name.rules.yaml]'"
            echo "--- $name: no unit tests here (exempt)"
            continue
        fi
        for t in "${tests[@]}"; do
            cp "$t" "$rules_dir/"
            (cd "$rules_dir" && promtool test rules "$(basename "$t")") >"$tmp/promtool.out" 2>&1 \
                || die "$t: promtool test rules failed: $(cat "$tmp/promtool.out")"
            echo "--- $t: promtool unit tests pass"
        done
    done <"$tmp/rule.names"
    # A test file for a rule that no longer exists would silently stop testing.
    for t in "$test_dir"/*.test.yaml; do
        orphan=1
        while IFS= read -r name; do
            if [[ "$(basename "$t")" == "$name.test.yaml" || "$(basename "$t")" == "$name".*.test.yaml ]]; then
                orphan=0
            fi
        done <"$tmp/rule.names"
        ((orphan == 0)) || die "$t does not belong to any PrometheusRule under kubernetes/"
    done
    shopt -u nullglob
}

# Check 10: Alloy configs. $1 is a scratch directory.
check_alloy_configs() {
    local tmp="$1" image="grafana/alloy:v1.21.1" file n=0 base cfg
    local -a runner
    mkdir -p "$tmp/alloy"
    if command -v alloy >/dev/null 2>&1; then
        runner=(alloy); base="$tmp/alloy"
    elif command -v docker >/dev/null 2>&1 && docker image inspect "$image" >/dev/null 2>&1; then
        runner=(docker run --rm -v "$tmp/alloy:/cfg:ro" "$image"); base=/cfg
    else
        echo "--- skipped: no alloy binary and $image is not in the local Docker cache"
        return 0
    fi
    find kubernetes -type f -name '*.yaml' ! -name kustomization.yaml ! -name '*.sops.yaml' -print0 | sort -z >"$tmp/alloy.files"
    while IFS= read -r -d '' file; do
        yq -N 'select(.kind == "HelmRelease") | .spec.values.alloy.configMap.content // ""' "$file" >"$tmp/alloy.content"
        [[ -n "$(tr -d '[:space:]' <"$tmp/alloy.content")" ]] || continue
        n=$((n + 1)); cfg="$tmp/alloy/$n.alloy"
        cp "$tmp/alloy.content" "$cfg"
        "${runner[@]}" validate "$base/$n.alloy" >"$tmp/alloy.out" 2>&1 \
            || die "$file: alloy validate failed: $(cat "$tmp/alloy.out")"
        "${runner[@]}" fmt "$base/$n.alloy" >"$tmp/alloy.out" 2>&1 \
            || die "$file: alloy fmt failed: $(cat "$tmp/alloy.out")"
        echo "--- $file: alloy validate and fmt pass"
    done <"$tmp/alloy.files"
}

validate_tree() {
    local root="$1"
    [[ -d "$root/kubernetes/flux" && -d "$root/kubernetes/apps" ]] \
        || die "$root does not contain kubernetes/flux and kubernetes/apps"

    (
        cd "$root"
        local file dir name missing extra namespace path index src_kind src_name src_ns ref rc tmp
        tmp="$(mktemp -d)"
        trap 'rm -rf "$tmp"' EXIT

        "$(dirname "$script_path")/validate-apps.sh" .

        # File lists and yq queries are written out as standalone commands
        # first, so that a failing find or yq aborts the run (errexit does not
        # see failures inside a `< <(...)` process substitution).
        find kubernetes/flux -type f -name '*.yaml' ! -name kustomization.yaml -print0 \
            | sort -z >"$tmp/standalone"
        find kubernetes/flux kubernetes/apps -type f -name kustomization.yaml -print0 \
            | sort -z >"$tmp/kustomizations"
        find kubernetes/flux kubernetes/apps -type f -name '*.yaml' \
            ! -name kustomization.yaml ! -name '*.sops.yaml' -print0 | sort -z >"$tmp/manifests"

        echo "=== kubernetes/apps/kustomization.yaml lists every app folder ==="
        # cluster-apps has prune: true, and Flux uses kubernetes/apps/kustomization.yaml
        # as-is (it only generates one when absent). A folder missing from the list
        # would be pruned, with the live Kustomizations it defines; an entry for a
        # missing folder would fail the whole build. Candidates: each directory with
        # a kustomization.yaml that lists ks.yaml files and that no other
        # kustomization.yaml in kubernetes/apps includes as a folder (network/tailscale
        # is listed here, not by network/, whose namespace: would override it).
        yq '.resources[]' kubernetes/apps/kustomization.yaml | sort >"$tmp/apps.listed"
        find kubernetes/apps -mindepth 2 -type f -name kustomization.yaml -print0 | sort -z >"$tmp/apps.kfiles"
        : >"$tmp/apps.nested"
        while IFS= read -r -d '' file; do
            yq '(.resources // [])[] | select(test("\\.ya?ml$") | not)' "$file" \
                | while IFS= read -r ref; do
                    [[ -n "$ref" ]] || continue
                    (cd "$(dirname "$file")" && cd "$ref" 2>/dev/null && pwd -P) || true
                done >>"$tmp/apps.nested"
        done <"$tmp/apps.kfiles"
        : >"$tmp/apps.expected"
        while IFS= read -r -d '' file; do
            dir="$(dirname "$file")"
            [[ "$(dirname "$dir")" == kubernetes/apps ]] && { echo "./$(basename "$dir")" >>"$tmp/apps.expected"; continue; }
            # Only folders that list Flux Kustomization files (ks.yaml): an app's
            # app/, config/ ... folders are reached through spec.path instead.
            [[ "$(yq '[(.resources // [])[] | select(test("(^|/)ks\\.yaml$"))] | length' "$file")" != 0 ]] || continue
            grep -qxF "$(cd "$dir" && pwd -P)" "$tmp/apps.nested" || echo "./${dir#kubernetes/apps/}" >>"$tmp/apps.expected"
        done <"$tmp/apps.kfiles"
        for f in kubernetes/apps/*/kustomization.yaml; do echo "./$(basename "$(dirname "$f")")" >>"$tmp/apps.expected"; done
        sort -u "$tmp/apps.expected" -o "$tmp/apps.expected"
        missing="$(comm -13 "$tmp/apps.listed" "$tmp/apps.expected")"
        [[ -z "$missing" ]] \
            || die "kubernetes/apps/kustomization.yaml does not list: ${missing//$'\n'/ } (cluster-apps has prune: true, so Flux would prune what they define)"
        extra="$(comm -23 "$tmp/apps.listed" "$tmp/apps.expected")"
        [[ -z "$extra" ]] \
            || die "kubernetes/apps/kustomization.yaml lists folders without a kustomization.yaml that no other one includes: ${extra//$'\n'/ }"

        echo "=== kubeconform: standalone manifests in kubernetes/flux ==="
        while IFS= read -r -d '' file; do
            echo "--- $file"
            conform <"$file"
        done <"$tmp/standalone"

        echo "=== kustomize build | kubeconform ==="
        : >"$tmp/oci.list"
        while IFS= read -r -d '' file; do
            dir="$(dirname "$file")"
            echo "--- $dir"
            kustomize build "$dir" "${kustomize_args[@]}" >"$tmp/build.yaml"
            conform <"$tmp/build.yaml"
            check_direct_response_bodies "$tmp/build.yaml" "$dir"
            yq -N 'select(.kind == "Namespace") | .metadata.name' "$tmp/build.yaml" >"$tmp/namespaces"
            while IFS= read -r name; do
                [[ -z "$name" || "$name" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] \
                    || die "$dir: Namespace name '$name' is not a lowercase RFC 1123 label"
            done <"$tmp/namespaces"
            list_oci_repositories "$tmp/build.yaml" >>"$tmp/oci.list"
        done <"$tmp/kustomizations"

        echo "=== flux build ks --dry-run | kubeconform ==="
        : >"$tmp/external.list"
        while IFS= read -r -d '' file; do
            # metadata.namespace: flux build's default is flux-system. The raw
            # sourceRef.namespace is kept ("" when omitted) so it can be
            # required below.
            yq -N 'select(.apiVersion == "kustomize.toolkit.fluxcd.io/*" and .kind == "Kustomization")
                | [documentIndex, .metadata.name // "", .metadata.namespace // "",
                   .spec.path // "", .spec.sourceRef.kind // "",
                   .spec.sourceRef.name // "", .spec.sourceRef.namespace // ""]
                | join("|")' "$file" >"$tmp/ks.list"
            # yq prints an empty line when nothing matches. "|" rather than a
            # tab, because read collapses consecutive whitespace separators.
            while IFS='|' read -r index name namespace path src_kind src_name src_ns; do
                [[ -n "$index" ]] || continue
                [[ -n "$name" && -n "$path" ]] || die "$file: Flux Kustomization without metadata.name or spec.path"
                yq "select(documentIndex == $index)" "$file" >"$tmp/ks.yaml"
                case "$src_kind" in
                    GitRepository)
                        # The only GitRepository is this repo. Without an
                        # explicit namespace Flux looks in the Kustomization's
                        # effective namespace (often set by a parent
                        # kustomization.yaml, so not visible here), and a
                        # misspelt name would point at nothing.
                        [[ -n "$src_ns" ]] \
                            || die "$file: $name: GitRepository sourceRef needs an explicit namespace (flux-system)"
                        [[ "$src_ns/$src_name" == "flux-system/flux-system" ]] \
                            || die "$file: $name: GitRepository sourceRef must be flux-system/flux-system, not $src_ns/$src_name"
                        ;;
                    OCIRepository)
                        # Built from another source, so only checked here and
                        # resolved against the declared OCIRepositories below.
                        src_ns="${src_ns:-$namespace}"
                        [[ -n "$src_ns" ]] \
                            || die "$file: $name: OCIRepository sourceRef needs sourceRef.namespace or metadata.namespace"
                        echo "--- $file (${namespace:-flux-system}/$name: skipped (external source) OCIRepository $src_ns/$src_name)"
                        echo "$file|$name|$src_ns/$src_name" >>"$tmp/external.list"
                        conform <"$tmp/ks.yaml"
                        continue
                        ;;
                    *)
                        die "$file: $name: unsupported sourceRef kind '${src_kind}'"
                        ;;
                esac
                namespace="${namespace:-flux-system}"
                echo "--- $file ($namespace/$name -> $path)"
                conform <"$tmp/ks.yaml"
                flux build ks "$name" --namespace "$namespace" --dry-run --path "$path" \
                    --kustomization-file "$tmp/ks.yaml" >"$tmp/build.yaml"
                conform <"$tmp/build.yaml"
                check_direct_response_bodies "$tmp/build.yaml" "$file ($namespace/$name)"
                list_oci_repositories "$tmp/build.yaml" >>"$tmp/oci.list"
            done <"$tmp/ks.list"
        done <"$tmp/manifests"

        echo "=== external sources are declared ==="
        # A skipped Kustomization must at least point at an OCIRepository this
        # tree declares (same name and namespace, after kustomize namespace
        # transformers and Flux targetNamespace), or Flux would never find it.
        while IFS='|' read -r file name ref; do
            grep -qxF "$ref" "$tmp/oci.list" \
                || die "$file: $name: OCIRepository $ref is not declared under kubernetes/"
            echo "--- $file ($name -> OCIRepository $ref)"
        done <"$tmp/external.list"

        echo '=== unclosed ${VAR substitutions ==='
        # Flux postBuild leaves an unterminated `${VAR` untouched, so the typo
        # would only surface as a broken value at runtime. grep exits 1 when
        # nothing matches; anything above 1 is a real error.
        rc=0
        grep -rnE --include='*.yaml' '\$\{[^}]*$' kubernetes >"$tmp/unclosed" || rc=$?
        ((rc <= 1)) || die "grep failed while checking for unclosed \${"
        if ((rc == 0)); then
            cat "$tmp/unclosed" >&2
            die 'unclosed ${ substitution (missing "}") in the lines above'
        fi

        echo '=== ${SECRET_DOMAIN} uses ==='
        # SECRET_DOMAIN is the bare zone; LAN hostnames use SECRET_DOMAIN_LOCAL.
        # Until October 26, 2026 SECRET_DOMAIN meant local.<zone>, so a manifest
        # written before then would silently point at <app>.<zone>. A file that
        # really means the bare zone goes in zone_allow.
        zone_allow=()
        rc=0
        # Any substitution form: ${V}, ${V:=x}, ${V=x}, ${V/a/b}, ${V#x}, ${#V}...
        grep -rnE '\$\{#?SECRET_DOMAIN([^A-Za-z0-9_]|$)' kubernetes >"$tmp/zone" || rc=$?
        ((rc <= 1)) || die "grep failed while checking for \${SECRET_DOMAIN}"
        for f in ${zone_allow[@]+"${zone_allow[@]}"}; do
            grep -vF "$f:" "$tmp/zone" >"$tmp/zone.keep" || true
            mv "$tmp/zone.keep" "$tmp/zone"
        done
        if [[ -s "$tmp/zone" ]]; then
            cat "$tmp/zone" >&2
            die '${SECRET_DOMAIN} is the bare zone: use ${SECRET_DOMAIN_LOCAL} for LAN names, or add the file to zone_allow'
        fi

        echo "=== flux-operator web UI has a fixed identity ==="
        # See rbac.yaml next to the HelmRelease: the web config makes the UI send
        # every request as this user, whose read-only role is the whole of what
        # visitors can see. The chart still renders a valid release without it.
        file=kubernetes/apps/flux-system/flux-operator/app/helmrelease.yaml
        [[ -f "$file" ]] || die "$file is missing: the flux-operator web UI identity cannot be checked"
        # Standalone commands, so that a failing yq aborts the run.
        yq -N 'select(.kind == "HelmRelease" and .metadata.name == "flux-operator") | .metadata.name' "$file" >"$tmp/webui.found"
        [[ "$(grep -c . "$tmp/webui.found")" == 1 ]] \
            || die "$file: expected exactly one HelmRelease named flux-operator"
        yq -N 'select(.kind == "HelmRelease" and .metadata.name == "flux-operator")
            | .spec.values.web.enabled' "$file" >"$tmp/webui.enabled"
        yq -N 'select(.kind == "HelmRelease" and .metadata.name == "flux-operator")
            | .spec.values.web.config.authentication.anonymous.username // ""' "$file" >"$tmp/webui.name"
        enabled="$(<"$tmp/webui.enabled")"
        name="$(<"$tmp/webui.name")"
        if [[ "$enabled" == false ]]; then
            echo "--- web.enabled is false: no web UI to protect"
        else
            [[ "$name" == flux-web-anon ]] \
                || die "$file: spec.values.web.config.authentication.anonymous.username must be flux-web-anon, the user rbac.yaml binds. Anything else gives the web UI another identity, and leaving it out makes the UI read the cluster as the operator (cluster-admin). Set it, or set web.enabled: false"
            # The read-only role does not bound these: the cached search index is
            # built with the operator's account, FineGrained actions run as that
            # account, and valuesFrom or postRenderers can replace the values.
            yq -N 'select(.kind == "HelmRelease" and .metadata.name == "flux-operator")
                | [.spec.values.web.config.search.cached != false and .spec.values.web.config.search.cached != null,
                   .spec.values.web.userActions.access == "FineGrained",
                   .spec.values.web.config.userActions.access == "FineGrained",
                   (.spec.valuesFrom | length) > 0,
                   (.spec.postRenderers | length) > 0,
                   (.spec.values.web.config.authentication.anonymous.groups | length) > 0]
                | any' "$file" >"$tmp/webui.unsafe"
            [[ "$(<"$tmp/webui.unsafe")" == false ]] \
                || die "$file: web.config.search.cached, FineGrained user actions, valuesFrom, postRenderers and anonymous groups are not allowed on this release, because they bypass or can replace the web UI's read-only identity"
            app="$(dirname "$file")"
            yq -N '(.patches | length) + (.patchesStrategicMerge | length) + (.spec.patches | length)' \
                "$app/kustomization.yaml" "$app/../ks.yaml" >"$tmp/webui.patches"
            if grep -qv '^0$' "$tmp/webui.patches"; then
                die "$app: patches are not allowed in kustomization.yaml or ks.yaml, because they can replace the web UI's read-only identity"
            fi
            echo "--- $file (web UI sends requests as '$name')"
        fi

        echo "=== PrometheusRule files: promtool check and unit tests ==="
        check_prometheus_rules "$tmp"

        echo "=== Alloy configurations: alloy validate and fmt ==="
        check_alloy_configs "$tmp"
    )
    echo "=== kubernetes manifests are valid ==="
}

require_tools
setup_cache

validate_tree "${1:-$(git -C "$(dirname "$script_path")" rev-parse --show-toplevel)}"
