terraform {
  required_version = ">= 1.9"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.28"
    }
  }

  # Separate root and local state (gitignored) from ../ (Proxmox), so a DNS
  # apply can never touch VMs. It holds no secrets. If it is lost, `just dns
  # ids` prints the full import command with the real IDs filled in. Run it
  # from terraform/dns:
  #   sops exec-env cloudflare.sops.env 'terraform import cloudflare_dns_record.local_wildcard <zone_id>/<record_id>'
}
