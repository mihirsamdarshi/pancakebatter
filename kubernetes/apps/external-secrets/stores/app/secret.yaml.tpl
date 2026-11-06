# Input for `just external-secrets token-secret`: `op inject` fills in the
# 1Password reference and the result is piped straight into `sops encrypt`, so
# the plaintext never touches disk. Never commit a filled-in copy of this file.
# The item is Private/ESO Homelab service account, field `token`. Private, not
# Homelab: the service account cannot read Private, so it cannot read its own
# token. If you prefer stable IDs (as the Tailscale template does), replace the
# names with the item and field IDs.
apiVersion: v1
kind: Secret
metadata:
  name: onepassword-service-account
  annotations:
    kustomize.toolkit.fluxcd.io/substitute: disabled
type: Opaque
stringData:
  token: "{{ op://Private/ESO Homelab service account/token }}"
