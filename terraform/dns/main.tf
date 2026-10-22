# Run this root through its just recipes (terraform/dns/mod.just):
#   just dns init      once per clone
#   just dns plan      plan; exit code 2 means drift
#   just dns apply     save a plan, confirm, apply exactly that plan
#   just dns secrets   regenerate cloudflare.sops.env from 1Password
#   just dns ids       zone and record IDs for `terraform import`
# Each one decrypts cloudflare.sops.env into the environment of a single
# `sops exec-env` process. It sets CLOUDFLARE_API_TOKEN (Zone:Read +
# Zone:DNS:Edit on the one zone) and TF_VAR_zone. The zone comes from the
# encrypted env file only for convenience: the domain itself is public (DNS,
# Certificate Transparency logs) and is not a secret.
provider "cloudflare" {}

variable "zone" {
  description = "Cloudflare zone (the public domain). Set via TF_VAR_zone from cloudflare.sops.env."
  type        = string
}

variable "internal_gateway_ip" {
  description = "envoy-internal LoadBalancer IP on the Servers VLAN (Cilium pool .10-.19)."
  type        = string
  default     = "192.168.10.10"
}

data "cloudflare_zone" "this" {
  filter = {
    name = var.zone
  }
}

# Internal apps live under local.<zone>. One unproxied wildcard resolves every
# app to the internal gateway from ordinary resolvers (LAN, Tailscale),
# without router DNS changes. Resolvers with DNS-rebind filtering drop it, and
# iCloud Private Relay is untested. It points at a private address,
# so nothing becomes reachable from the internet, and per-app names never
# leave the cluster.
#
# This holds only while cluster.toml keeps ingress.mode = "none". Any other
# mode renders the template's cloudflare-dns external-dns (domainFilters on
# local.<zone>, --cloudflare-proxied) and the Cloudflare tunnel, which would
# publish or claim proxied names under local. and break the "never exposed"
# requirement. Change that template first if ingress is ever turned on.
resource "cloudflare_dns_record" "local_wildcard" {
  zone_id = data.cloudflare_zone.this.zone_id
  name    = "*.local.${var.zone}"
  type    = "A"
  content = var.internal_gateway_ip
  ttl     = 300
  proxied = false
  comment = "Internal apps (envoy-internal); managed by terraform/dns"
}
