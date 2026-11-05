set quiet
set shell := ['bash', '-euo', 'pipefail', '-c']
set script-interpreter := ['bash', '-euo', 'pipefail']
set default-list
set default-script

# Run as `just csec <recipe>` (root justfile: mod? csec). Recipes run in this
# directory. Every Terraform call except init goes through `sops exec-env`, so
# the token lives only in the environment of that one process.

[doc('Regenerate cloudflare.sops.env from 1Password (needs a signed-in op)')]
[group('csec')]
secrets:
    op whoami >/dev/null
    tmp="$(mktemp cloudflare.sops.env.tmp.XXXXXX)"
    trap 'rm -f "$tmp"' EXIT
    op inject --in-file cloudflare.env.tpl \
        | sops encrypt --filename-override terraform/cloudflare-security/cloudflare.sops.env \
            --input-type dotenv --output-type dotenv /dev/stdin > "$tmp"
    sops decrypt --input-type dotenv --output-type dotenv "$tmp" >/dev/null
    for key in CLOUDFLARE_API_TOKEN TF_VAR_zone; do
        if ! grep -q "^${key}=ENC\[" "$tmp"; then
            just log error "Refusing to replace cloudflare.sops.env: missing encrypted value" key "$key"
            exit 1
        fi
    done
    mv "$tmp" cloudflare.sops.env
    just log info "Regenerated cloudflare.sops.env"

[doc('Initialize the providers (once per clone)')]
[group('csec')]
init:
    terraform init -input=false

# Read-only. Prints the zone's custom-rule entrypoint: ruleset id and, for each
# rule, ref, action, enabled, description and expression. Copy every rule into
# local.carried_rules before the first plan. A 404 means no entrypoint exists.
[doc('Read-only: list the existing custom rules (copy them into carried_rules)')]
[group('csec')]
entrypoint:
    sops exec-env cloudflare.sops.env '"{{ just_executable() }}" --justfile "{{ source_file() }}" _entrypoint'

[private]
_entrypoint:
    cf() {
        printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" \
            | curl --silent --show-error --header @- "https://api.cloudflare.com/client/v4/$1" "${@:2}"
    }
    zone_id="$(cf zones --get --data-urlencode "name=${TF_VAR_zone}" | jq -er '.result[0].id // error("zone not found (bad token?)")')"
    out="$(cf "zones/${zone_id}/rulesets/phases/http_request_firewall_custom/entrypoint" --write-out '\n%{http_code}')"
    code="${out##*$'\n'}"; body="${out%$'\n'*}"
    echo "zone_id=${zone_id}"
    if [[ "$code" == 404 ]]; then echo "entrypoint: none (no custom rules exist)"; exit 0; fi
    [[ "$code" == 200 ]] || { echo "unexpected HTTP $code" >&2; exit 1; }
    jq -r '"ruleset_id=\(.result.id)\nruleset_name=\(.result.name)\nruleset_kind=\(.result.kind)\nruleset_description=\(.result.description)\nrules=\(.result.rules // [] | length)"' <<<"$body"
    echo "NOTE: in provider 5.28.1 the name, kind, phase and zone_id force replacement. Set variable ruleset_name in main.tf to the ruleset_name above (default is \"default\") and keep kind zone, before the first plan."
    jq -r '(.result.rules // [])[] | "- ref=\(.ref // .id) action=\(.action) enabled=\(.enabled)\n  description=\(.description)\n  expression=\(.expression)"' <<<"$body"
    echo "import command: terraform import cloudflare_ruleset.custom zones/${zone_id}/$(jq -r '.result.id' <<<"$body")"
    echo "import command: terraform import cloudflare_bot_management.this ${zone_id}"

# Imports what already exists, so the first plan changes it instead of
# replacing it. Run it once, after carried_rules lists every existing rule.
[doc('Import the existing ruleset (if any) and Bot Management settings into state')]
[group('csec')]
import:
    sops exec-env cloudflare.sops.env '"{{ just_executable() }}" --justfile "{{ source_file() }}" _import'

[private]
_import:
    cf() {
        printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" \
            | curl --silent --show-error --header @- "https://api.cloudflare.com/client/v4/$1" "${@:2}"
    }
    zone_id="$(cf zones --get --data-urlencode "name=${TF_VAR_zone}" | jq -er '.result[0].id // error("zone not found")')"
    terraform state show cloudflare_bot_management.this >/dev/null 2>&1 \
        || terraform import -input=false cloudflare_bot_management.this "${zone_id}"
    if ! terraform state show cloudflare_ruleset.custom >/dev/null 2>&1; then
        out="$(cf "zones/${zone_id}/rulesets/phases/http_request_firewall_custom/entrypoint" --write-out '\n%{http_code}')"
        code="${out##*$'\n'}"; body="${out%$'\n'*}"
        if [[ "$code" == 200 ]]; then
            want="${TF_VAR_ruleset_name:-$(sed -n '/variable "ruleset_name"/,/}/s/^ *default *= *"\(.*\)"/\1/p' main.tf)}"
            have="$(jq -r '.result.name' <<<"$body")"; kind="$(jq -r '.result.kind' <<<"$body")"
            if [[ "$have" != "$want" || "$kind" != zone ]]; then
                echo "entrypoint name is '$have' (kind $kind) but ruleset_name is '$want'; a different name or kind would force replacement. Set the ruleset_name default in main.tf to '$have' and rerun." >&2
                exit 1
            fi
            terraform import -input=false cloudflare_ruleset.custom "zones/${zone_id}/$(jq -r '.result.id' <<<"$body")"
        else
            echo "no entrypoint (HTTP $code): nothing to import for the ruleset"
        fi
    fi

# Gate: refuses to plan while an entrypoint with rules exists and is not in
# state, because apply would then overwrite it. Then saves plan.out and runs
# `check`.
[doc('Plan to plan.out, then fail if any rule or resource would be deleted')]
[group('csec')]
plan:
    sops exec-env cloudflare.sops.env '"{{ just_executable() }}" --justfile "{{ source_file() }}" _guard'
    rc=0
    sops exec-env cloudflare.sops.env 'terraform plan -input=false -detailed-exitcode -out=plan.out' || rc=$?
    [[ "$rc" == 0 || "$rc" == 2 ]] || exit "$rc"
    just csec check
    exit "$rc"

[private]
_guard:
    if ! terraform state show cloudflare_ruleset.custom >/dev/null 2>&1; then
        cf() {
            printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" \
                | curl --silent --show-error --header @- "https://api.cloudflare.com/client/v4/$1" "${@:2}"
        }
        zone_id="$(cf zones --get --data-urlencode "name=${TF_VAR_zone}" | jq -er '.result[0].id // error("zone not found (bad token?)")')"
        out="$(cf "zones/${zone_id}/rulesets/phases/http_request_firewall_custom/entrypoint" --write-out '\n%{http_code}')"
        code="${out##*$'\n'}"; body="${out%$'\n'*}"
        case "$code" in
            404) ;;
            200)
                n="$(jq -r '(.result.rules // []) | length' <<<"$body")"
                if [[ "$n" != 0 ]]; then
                    echo "The zone has $n custom rule(s) and the ruleset is not in state. Run entrypoint, copy the rules into carried_rules, then import." >&2
                    exit 1
                fi ;;
            *) echo "Could not read the entrypoint (HTTP $code); refusing to plan." >&2; exit 1 ;;
        esac
    fi

# Fails when plan.out would delete or replace anything, or would remove or
# change any existing (carried) rule. Only the Flux rule may differ.
[doc('Fail if plan.out deletes anything or removes or changes any carried rule')]
[group('csec')]
check:
    terraform show -json plan.out > plan.json
    trap 'rm -f plan.json' EXIT
    if [[ "$(jq '(.resource_changes // []) | length' plan.json)" == 0 ]]; then
        just log info "plan.out has no resource changes; nothing to check"
        exit 0
    fi
    jq -e -f check.jq plan.json >/dev/null \
        || { just log error "plan.out would delete a resource or remove or change a carried rule; do not apply"; exit 1; }
    just log info "no deletes, no removed or changed carried rules"

[doc('Plan, check, confirm, then apply exactly that plan')]
[group('csec')]
apply:
    trap 'rm -f plan.out' EXIT
    rc=0; just csec plan || rc=$?
    case "$rc" in 0) just log info "No changes"; exit 0 ;; 2) ;; *) exit "$rc" ;; esac
    [[ -t 0 && -t 1 ]] || { just log error "apply needs an interactive terminal"; exit 1; }
    rc=0; gum confirm --default=false 'Apply plan.out to Cloudflare?' || rc=$?
    case "$rc" in 0) ;; 1|130) just log warn "Apply cancelled"; exit 0 ;; *) exit "$rc" ;; esac
    sops exec-env cloudflare.sops.env 'terraform apply -input=false plan.out'
