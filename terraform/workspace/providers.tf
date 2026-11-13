# Credentials come from the environment, decrypted on the fly (see mod.just):
#   sops exec-env ../proxmox.sops.env 'sops exec-env workspace.sops.env "terraform plan"'
# ../proxmox.sops.env sets PROXMOX_VE_ENDPOINT, PROXMOX_VE_API_TOKEN and
# PROXMOX_VE_INSECURE; workspace.sops.env sets TF_VAR_zone. This root reuses the
# Talos token (terraform@pve). For VM 401 it needs the `workspace` pool and ACLs
# on /pool/workspace and /vms/401 (TerraformTalosVM), plus PVEDatastoreUser on
# /storage/local to attach the snippet. It still has no rights on VM 999
# (TrueNAS) or the host.
provider "proxmox" {}
