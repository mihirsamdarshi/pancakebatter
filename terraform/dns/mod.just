set quiet
set shell := ['bash', '-euo', 'pipefail', '-c']
set script-interpreter := ['bash', '-euo', 'pipefail']
set default-list
set default-script

# Recipes run in this directory. Every Terraform call goes through
# `sops exec-env`, so the token lives only in the environment of that one
# process and never touches disk in plaintext. The zone name rides along in
# the same file for convenience; the domain is public, not a secret.

[doc('Regenerate cloudflare.sops.env from 1Password (needs a signed-in op)')]
[group('dns')]
secrets:
    op whoami >/dev/null
    # Same directory, so the final mv is an atomic rename; the committed file
    # is only replaced once a complete, fully encrypted copy exists.
    tmp="$(mktemp cloudflare.sops.env.tmp.XXXXXX)"
    trap 'rm -f "$tmp"' EXIT
    op inject --in-file cloudflare.env.tpl \
        | sops encrypt --filename-override terraform/dns/cloudflare.sops.env \
            --input-type dotenv --output-type dotenv /dev/stdin > "$tmp"
    for key in CLOUDFLARE_API_TOKEN TF_VAR_zone; do
        if ! grep -q "^${key}=ENC\[" "$tmp"; then
            just log error "Refusing to replace cloudflare.sops.env: missing encrypted value" key "$key"
            exit 1
        fi
    done
    mv "$tmp" cloudflare.sops.env
    just log info "Regenerated cloudflare.sops.env"

[doc('Initialize the providers (once per clone)')]
[group('dns')]
init:
    terraform init -input=false

# -detailed-exitcode: 0 = no changes, 2 = changes pending (just reports it
# as a failure), 1 = error.
[doc('Show pending DNS changes (exit code 2 means drift)')]
[group('dns')]
plan:
    sops exec-env cloudflare.sops.env 'terraform plan -input=false -detailed-exitcode'

# The plan is saved and shown first; the confirm prompt on the private
# recipe runs after it, and apply uses exactly that saved plan.
[doc('Plan, confirm, then apply exactly that plan to Cloudflare')]
[group('dns')]
apply: && _apply-plan
    rm -f plan.out
    sops exec-env cloudflare.sops.env 'terraform plan -input=false -out=plan.out'

[confirm('Apply plan.out to Cloudflare? [y/N]')]
[private]
_apply-plan:
    trap 'rm -f plan.out' EXIT
    sops exec-env cloudflare.sops.env 'terraform apply -input=false plan.out'

# Read-only lookup for `terraform import` after state loss. The token reaches
# curl on stdin (-H @-), never on the command line, and only IDs are printed.
[doc('Print the zone and wildcard record IDs for terraform import')]
[group('dns')]
ids:
    sops exec-env cloudflare.sops.env '"{{ just_executable() }}" --justfile "{{ source_file() }}" _ids'

[private]
_ids:
    cf() {
        curl --silent --show-error --fail-with-body --get \
            --header @- "https://api.cloudflare.com/client/v4/$1" "${@:2}" \
            <<<"Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
    }
    zone_id="$(cf zones --data-urlencode "name=${TF_VAR_zone}" | jq -er '.result[0].id')"
    record_id="$(cf "zones/${zone_id}/dns_records" \
        --data-urlencode 'type=A' \
        --data-urlencode "name.exact=*.local.${TF_VAR_zone}" \
        | jq -er '.result[0].id')"
    echo "zone_id=${zone_id}"
    echo "record_id=${record_id}"
    echo "terraform import cloudflare_dns_record.local_wildcard '${zone_id}/${record_id}'"
