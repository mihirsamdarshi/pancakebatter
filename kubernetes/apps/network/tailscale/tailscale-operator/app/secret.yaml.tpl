# Input for `just tailscale oauth-secret`: `op inject` fills in the 1Password
# references and the result is piped straight into `sops encrypt`, so the
# plaintext never touches disk. Never commit a filled-in copy of this file.
# Stable item/field IDs survive changes to display labels and sections.
apiVersion: v1
kind: Secret
metadata:
  name: tailscale-operator-oauth
type: Opaque
stringData:
  client_id: "{{ op://Private/pvrh3uuo6vc7qrhbwx75ye467e/upwyncsjcld4nhyl2zbdu3ljl4 }}"
  client_secret: "{{ op://Private/pvrh3uuo6vc7qrhbwx75ye467e/iyoc4edgbtfhkquo3oc4k37kiy }}"
