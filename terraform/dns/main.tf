# Run this root through its just recipes (terraform/dns/mod.just):
#   just dns init      once per clone
#   just dns plan      plan; exit code 2 means drift
#   just dns apply     save a plan, confirm, apply exactly that plan
#   just dns secrets   regenerate cloudflare.sops.env from 1Password
#   just dns ids       IDs and the full `terraform import` command
# Each one except init decrypts cloudflare.sops.env into the environment of a
# single `sops exec-env` process. It sets CLOUDFLARE_API_TOKEN (Zone:Read +
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
# so nothing becomes reachable from the internet. App queries can still reach
# public resolvers; the wildcard avoids publishing separate app records.
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

variable "family_gateway_ip" {
  description = "Standalone family-apps node's Tailscale IPv4 address. Null keeps family DNS unconfigured."
  type        = string
  default     = null
  validation {
    condition     = var.family_gateway_ip == null || can(cidrnetmask("${var.family_gateway_ip}/32"))
    error_message = "family_gateway_ip must be an IPv4 address."
  }
}

# Family apps live under family.<zone>, a separate wildcard from the LAN-only
# *.local.<zone>. The 100.x address is reachable through Tailscale node sharing,
# not the public internet. Each recipient accepts one gateway share for all
# family apps.
resource "cloudflare_dns_record" "family_zone_wildcard" {
  count   = var.family_gateway_ip == null ? 0 : 1
  zone_id = data.cloudflare_zone.this.zone_id
  name    = "*.family.${var.zone}"
  type    = "A"
  content = var.family_gateway_ip
  ttl     = 300
  proxied = false
  comment = "Family apps (shared Tailscale gateway); managed by terraform/dns"
}

# The bare family name serves the landing page (an app list). The wildcard above
# does not cover it: a wildcard needs at least one label.
resource "cloudflare_dns_record" "family_landing" {
  count   = var.family_gateway_ip == null ? 0 : 1
  zone_id = data.cloudflare_zone.this.zone_id
  name    = "family.${var.zone}"
  type    = "A"
  content = var.family_gateway_ip
  ttl     = 300
  proxied = false
  comment = "Family landing page (shared Tailscale gateway); managed by terraform/dns"
}

# Previous family names (*.family.local.<zone>), kept while clients move to
# *.family.<zone>. Remove this record with the matching envoy-family listener
# and certificate name.
resource "cloudflare_dns_record" "family_wildcard" {
  count   = var.family_gateway_ip == null ? 0 : 1
  zone_id = data.cloudflare_zone.this.zone_id
  name    = "*.family.local.${var.zone}"
  type    = "A"
  content = var.family_gateway_ip
  ttl     = 300
  proxied = false
  comment = "Family apps (shared Tailscale gateway); managed by terraform/dns"
}
