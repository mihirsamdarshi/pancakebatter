# Input for `just tailscale oauth-secret`: `op inject` fills in the 1Password
# references and the result is piped straight into `sops encrypt`, so the
# plaintext never touches disk. Never commit a filled-in copy of this file.
apiVersion: v1
kind: Secret
metadata:
  name: tailscale-operator-oauth
type: Opaque
stringData:
  client_id: "{{ op://Private/Tailscale K8s Operator OAuth/client_id }}"
  client_secret: "{{ op://Private/Tailscale K8s Operator OAuth/client_secret }}"
