terraform {
  required_version = ">= 1.9"

  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.117.0"
    }
  }

  # State is intentionally local (terraform.tfstate, gitignored); single operator.
  # It holds no secrets. If it is lost, re-import the VMs:
  #   terraform import 'proxmox_virtual_environment_vm.talos["talos-01"]' hobbes/301
}
