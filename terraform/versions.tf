terraform {
  required_version = ">= 1.9"

  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.117.0"
    }
  }

  # State is local for now (gitignored). Choose a durable, backed-up location before
  # the cluster holds anything important.
}
