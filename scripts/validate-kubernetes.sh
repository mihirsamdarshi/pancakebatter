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
#   3. `flux build ks --dry-run | kubeconform` for every Flux Kustomization,
#      which also catches a wrong spec.path and broken spec.patches.
# archive/ and other trees outside kubernetes/ are never read.

set -euo pipefail

script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

kustomize_args=("--load-restrictor=LoadRestrictionsNone")
kubeconform_args=(
    "-strict"
    "-summary"
    "-ignore-missing-schemas"
    "-skip" "Gateway,HTTPRoute,Secret"
    "-schema-location" "default"
    "-schema-location" "https://k8s-schemas.home-operations.com/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"
)

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
        local file dir name path index tmp
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
            kubeconform "${kubeconform_args[@]}" "$file"
        done <"$tmp/standalone"

        echo "=== kustomize build | kubeconform ==="
        while IFS= read -r -d '' file; do
            dir="$(dirname "$file")"
            echo "--- $dir"
            kustomize build "$dir" "${kustomize_args[@]}" | kubeconform "${kubeconform_args[@]}"
        done <"$tmp/kustomizations"

        echo "=== flux build ks --dry-run | kubeconform ==="
        while IFS= read -r -d '' file; do
            yq -N 'select(.apiVersion == "kustomize.toolkit.fluxcd.io/*" and .kind == "Kustomization")
                | [documentIndex, .metadata.name // "", .spec.path // ""] | join("|")' "$file" >"$tmp/ks.list"
            # yq prints an empty line when nothing matches. "|" rather than a
            # tab, because read collapses consecutive whitespace separators.
            while IFS='|' read -r index name path; do
                [[ -n "$index" ]] || continue
                [[ -n "$name" && -n "$path" ]] || die "$file: Flux Kustomization without metadata.name or spec.path"
                echo "--- $file ($name -> $path)"
                yq "select(documentIndex == $index)" "$file" >"$tmp/ks.yaml"
                flux build ks "$name" --dry-run --path "$path" --kustomization-file "$tmp/ks.yaml" \
                    | kubeconform "${kubeconform_args[@]}"
            done <"$tmp/ks.list"
        done <"$tmp/manifests"
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
