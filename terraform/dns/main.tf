# Credentials and the zone name come from the environment, decrypted on the fly:
#   sops exec-env cloudflare.sops.env 'terraform plan'
# cloudflare.sops.env sets CLOUDFLARE_API_TOKEN (Zone:Read + Zone:DNS:Edit on the
# one zone) and TF_VAR_zone, which keeps the domain out of this public repo.
# Regenerate it from 1Password (in a terminal signed in to op):
#   op inject -i cloudflare.env.tpl | sops encrypt --filename-override terraform/dns/cloudflare.sops.env \
#     --input-type dotenv --output-type dotenv /dev/stdin > cloudflare.sops.env
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
# app to the internal gateway from any resolver (LAN, Tailscale, phones with
# Private Relay), without router DNS changes. It points at a private address,
# so nothing becomes reachable from the internet, and per-app names never
# leave the cluster.
resource "cloudflare_dns_record" "local_wildcard" {
  zone_id = data.cloudflare_zone.this.zone_id
  name    = "*.local.${var.zone}"
  type    = "A"
  content = var.internal_gateway_ip
  ttl     = 300
  proxied = false
  comment = "Internal apps (envoy-internal); managed by terraform/dns"
}
