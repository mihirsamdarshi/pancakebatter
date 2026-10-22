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
  # ids` prints the IDs and the import command; run that command inside
  #   sops exec-env cloudflare.sops.env '<import command>'
}
