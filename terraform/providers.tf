# Credentials come from the environment, decrypted on the fly:
#   sops exec-env proxmox.sops.env 'terraform plan'
# proxmox.sops.env sets PROXMOX_VE_ENDPOINT, PROXMOX_VE_API_TOKEN and PROXMOX_VE_INSECURE.
# The token belongs to terraform@pve, which can only manage VMs in the `talos` pool
# (plus allocate on local-lvm, read/upload images on local, use vmbr0). It has no
# rights on VM 999 (TrueNAS) or the host.
provider "proxmox" {}
