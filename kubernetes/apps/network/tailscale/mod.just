set quiet
set shell := ['bash', '-euo', 'pipefail', '-c']
set script-interpreter := ['bash', '-euo', 'pipefail']
set default-list
set default-script

# Recipes run in this directory (kubernetes/apps/network/tailscale).

[doc('Regenerate the operator OAuth SOPS Secret using 1Password CLI access')]
[group('tailscale')]
oauth-secret:
    out=tailscale-operator/app/secret.sops.yaml
    # Same directory, so the final mv is an atomic rename; the committed file
    # is only replaced once a complete, fully encrypted copy exists. Plaintext
    # only ever flows through the pipe and is never printed or written.
    tmp="$(mktemp "$out.tmp.XXXXXX")"
    trap 'rm -f "$tmp"' EXIT
    op inject --in-file tailscale-operator/app/secret.yaml.tpl \
        | sops encrypt --filename-override "kubernetes/apps/network/tailscale/$out" \
            --input-type yaml --output-type yaml /dev/stdin > "$tmp"
    # Round trip: catches a bad MAC or a file our key cannot decrypt. Prints nothing.
    sops decrypt --input-type yaml --output-type yaml "$tmp" >/dev/null
    for key in client_id client_secret; do
        if ! grep -Eq "^  ${key}: ENC\[" "$tmp"; then
            just log error "Refusing to replace secret.sops.yaml: missing encrypted value" key "$key"
            exit 1
        fi
    done
    mv "$tmp" "$out"
    just log info "Regenerated $out"
    if ! grep -Eq '^  - \./secret\.sops\.yaml$' tailscale-operator/app/kustomization.yaml; then
        just log warn "Uncomment ./secret.sops.yaml in tailscale-operator/app/kustomization.yaml"
    fi
