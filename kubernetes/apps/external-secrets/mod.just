set quiet
set shell := ['bash', '-euo', 'pipefail', '-c']
set script-interpreter := ['bash', '-euo', 'pipefail']
set default-list
set default-script

# Recipes run in this directory (kubernetes/apps/external-secrets).

[doc('Write the 1Password service account token as a SOPS Secret using 1Password CLI access')]
[group('external-secrets')]
token-secret:
    out=stores/app/onepassword-service-account.sops.yaml
    # Same directory, so the final mv is an atomic rename; the committed file
    # is only replaced once a complete, fully encrypted copy exists. Plaintext
    # only ever flows through the pipe and is never printed or written.
    tmp="$(mktemp "$out.tmp.XXXXXX")"
    trap 'rm -f "$tmp"' EXIT
    op inject --in-file stores/app/secret.yaml.tpl \
        | sops encrypt --filename-override "kubernetes/apps/external-secrets/$out" \
            --input-type yaml --output-type yaml /dev/stdin > "$tmp"
    # Round trip: catches a bad MAC or a file our key cannot decrypt. Prints nothing.
    sops decrypt --input-type yaml --output-type yaml "$tmp" >/dev/null
    if ! grep -Eq "^  token: ENC\[" "$tmp"; then
        just log error "Refusing to replace the token Secret: missing encrypted value" key token
        exit 1
    fi
    mv "$tmp" "$out"
    just log info "Regenerated $out"
