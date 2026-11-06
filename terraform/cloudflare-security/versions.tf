terraform {
  required_version = ">= 1.9"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.28"
    }
    http = {
      source  = "hashicorp/http"
      version = "~> 3.4"
    }
  }

  # Local state (gitignored), a separate root from ../dns and ../ (Proxmox), so
  # a security apply can never touch DNS records or VMs. It holds no secrets.
  # If it is lost, import both resources before the next plan (see mod.just
  # `import` and docs: the ruleset import comes first, so no rule is dropped).
}
