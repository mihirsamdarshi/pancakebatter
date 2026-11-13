terraform {
  required_version = ">= 1.9"

  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.117.0"
    }
  }

  # Separate root and local state (gitignored) from ../ (Talos VMs), so a Talos
  # plan never refreshes or waits on VM 401 and an apply on one can never touch
  # the other. It holds no secrets. If it is lost, re-import the VM from
  # terraform/workspace (both env files, as in mod.just):
  #   sops exec-env ../proxmox.sops.env 'sops exec-env workspace.sops.env "terraform import proxmox_virtual_environment_vm.workspace hobbes/401"'
}
