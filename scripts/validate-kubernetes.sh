#!/usr/bin/env bash
# Validates the Flux manifests under kubernetes/ before Flux applies them.
#
#   validate-kubernetes.sh [ROOT]   validate ROOT/kubernetes (default: repo root)
#   validate-kubernetes.sh --pre-push
#                                   read git's pre-push stdin and validate the
#                                   committed tree of every pushed ref whose
#                                   commits touch kubernetes/ (or this script)
#
# The lefthook pre-push hook, the Kubernetes workflow and `just template
# configure` all call this script, so the local gate and CI cannot drift. It
# lives outside template/ because `just template tidy` archives that folder.
#
# Checks, all of which fail the run:
#   1. kubeconform on standalone manifests under kubernetes/flux (Flux reads
#      kubernetes/flux/cluster directly; it has no kustomization.yaml);
#   2. `kustomize build | kubeconform` for every kustomization.yaml under
#      kubernetes/flux and kubernetes/apps;
#   3. kubeconform on every Flux Kustomization object, and
#      `flux build ks --dry-run | kubeconform` for each one whose sourceRef is
#      GitRepository flux-system/flux-system (this repo), which also catches a
#      wrong spec.path and broken spec.patches. A Kustomization that reads any
#      other source (e.g. a private OCIRepository) cannot be built from this
#      repo and is logged as "skipped (external source)";
#   4. no unclosed `${VAR` (a Flux postBuild substitution missing its `}`).
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

# kubeconform on stdin. Flux postBuild variables (${VAR}, ${VAR:=default},
# ${VAR/./-}) are filled in only at reconcile time, from cluster Secrets this
# script cannot read, so each one becomes a DNS-label-safe stand-in first.
# Otherwise every pattern-checked field holding one (an HTTPRoute or Gateway
# hostname, a Certificate dnsName) fails.
conform() {
    sed -E 's/\$\{[A-Za-z_][^}]*\}/placeholder/g' | kubeconform "${kubeconform_args[@]}"
}

die() {
    echo "validate-kubernetes: $*" >&2
    exit 1
}

# Fail closed: a missing tool must fail the gate, never skip it.
require_tools() {
    local tool missing=()
    for tool in kubeconform kustomize flux yq git; do
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

validate_tree() {
    local root="$1"
    [[ -d "$root/kubernetes/flux" && -d "$root/kubernetes/apps" ]] \
        || die "$root does not contain kubernetes/flux and kubernetes/apps"

    (
        cd "$root"
        local file dir name namespace path index src_kind src_name src_ns rc tmp
        tmp="$(mktemp -d)"
        trap 'rm -rf "$tmp"' EXIT

        # File lists and yq queries are written out as standalone commands
        # first, so that a failing find or yq aborts the run (errexit does not
        # see failures inside a `< <(...)` process substitution).
        find kubernetes/flux -type f -name '*.yaml' ! -name kustomization.yaml -print0 \
            | sort -z >"$tmp/standalone"
        find kubernetes/flux kubernetes/apps -type f -name kustomization.yaml -print0 \
            | sort -z >"$tmp/kustomizations"
        find kubernetes/flux kubernetes/apps -type f -name '*.yaml' \
            ! -name kustomization.yaml ! -name '*.sops.yaml' -print0 | sort -z >"$tmp/manifests"

        echo "=== kubeconform: standalone manifests in kubernetes/flux ==="
        while IFS= read -r -d '' file; do
            echo "--- $file"
            conform <"$file"
        done <"$tmp/standalone"

        echo "=== kustomize build | kubeconform ==="
        while IFS= read -r -d '' file; do
            dir="$(dirname "$file")"
            echo "--- $dir"
            kustomize build "$dir" "${kustomize_args[@]}" | conform
        done <"$tmp/kustomizations"

        echo "=== flux build ks --dry-run | kubeconform ==="
        while IFS= read -r -d '' file; do
            # An omitted metadata.namespace is flux build's default
            # (flux-system); an omitted sourceRef.namespace is the
            # Kustomization's own namespace.
            yq -N 'select(.apiVersion == "kustomize.toolkit.fluxcd.io/*" and .kind == "Kustomization")
                | (.metadata.namespace // "flux-system") as $ns
                | [documentIndex, .metadata.name // "", $ns, .spec.path // "",
                   .spec.sourceRef.kind // "", .spec.sourceRef.name // "",
                   .spec.sourceRef.namespace // $ns] | join("|")' "$file" >"$tmp/ks.list"
            # yq prints an empty line when nothing matches. "|" rather than a
            # tab, because read collapses consecutive whitespace separators.
            while IFS='|' read -r index name namespace path src_kind src_name src_ns; do
                [[ -n "$index" ]] || continue
                [[ -n "$name" && -n "$path" ]] || die "$file: Flux Kustomization without metadata.name or spec.path"
                yq "select(documentIndex == $index)" "$file" >"$tmp/ks.yaml"
                if [[ "$src_kind/$src_ns/$src_name" != "GitRepository/flux-system/flux-system" ]]; then
                    # Not this repo: validate the object, but its spec.path
                    # lives in another source.
                    echo "--- $file ($namespace/$name: skipped (external source) $src_kind $src_ns/$src_name)"
                    conform <"$tmp/ks.yaml"
                    continue
                fi
                echo "--- $file ($namespace/$name -> $path)"
                conform <"$tmp/ks.yaml"
                flux build ks "$name" --namespace "$namespace" --dry-run --path "$path" \
                    --kustomization-file "$tmp/ks.yaml" | conform
            done <"$tmp/ks.list"
        done <"$tmp/manifests"

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
    )
    echo "=== kubernetes manifests are valid ==="
}

# git pre-push stdin: "<local ref> <local oid> <remote ref> <remote oid>".
pre_push() {
    local zero _local_ref local_oid remote_ref remote_oid
    local -a oids=()
    zero="$(git hash-object --stdin </dev/null | tr '0-9a-f' '0')"
    local script_rel
    script_rel="$(git ls-files --full-name -- "$script_path")"
    [[ -n "$script_rel" ]] || script_rel="scripts/validate-kubernetes.sh"

    while read -r _local_ref local_oid remote_ref remote_oid; do
        [[ "$local_oid" == "$zero" ]] && continue # branch deletion
        # Unknown base (new remote branch, or a remote commit we lack):
        # validate rather than guess.
        if [[ "$remote_oid" != "$zero" ]] && git cat-file -e "$remote_oid^{commit}" 2>/dev/null \
            && git diff --quiet "$remote_oid" "$local_oid" -- kubernetes "$script_rel"; then
            echo "validate-kubernetes: $remote_ref: no kubernetes/ changes, skipping"
            continue
        fi
        oids+=("$local_oid")
    done

    ((${#oids[@]} > 0)) || return 0

    # Global, not local: the EXIT trap runs after this function returns.
    push_tmp="$(mktemp -d)"
    trap 'rm -rf "$push_tmp"' EXIT
    local oid
    for oid in $(printf '%s\n' "${oids[@]}" | sort -u); do
        echo "validate-kubernetes: validating committed tree of ${oid:0:12}"
        mkdir -p "$push_tmp/$oid"
        git archive --format=tar "$oid" kubernetes | tar -x -C "$push_tmp/$oid"
        validate_tree "$push_tmp/$oid"
    done
}

require_tools
setup_cache

if [[ "${1:-}" == "--pre-push" ]]; then
    pre_push
else
    validate_tree "${1:-$(git -C "$(dirname "$script_path")" rev-parse --show-toplevel)}"
fi
