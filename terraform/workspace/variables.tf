variable "zone" {
  description = "Search domain for the guest (the canonical <zone>). Set via TF_VAR_zone from workspace.sops.env, so the name stays out of tracked plaintext."
  type        = string
}

variable "proxmox_node" {
  description = "Proxmox node that hosts the workspace VM."
  type        = string
  default     = "hobbes"
}

variable "vm_datastore" {
  description = "Datastore for the system disk and the cloud-init drive (local NVMe, independent of TrueNAS)."
  type        = string
  default     = "local-lvm"
}

variable "bridge" {
  description = "Linux bridge for the NIC."
  type        = string
  default     = "vmbr0"
}

variable "vlan_id" {
  description = "VLAN tag for the NIC (10 = server network)."
  type        = number
  default     = 10
}

variable "prefix_length" {
  description = "Prefix length of the server network."
  type        = number
  default     = 24
}

variable "gateway" {
  description = "Gateway and DNS server on the server network (the UCG)."
  type        = string
  default     = "192.168.10.1"
}

variable "workspace" {
  description = "The workspace VM. Values are the owner's choices of 2026-11-13."
  type = object({
    vm_id      = number
    name       = string
    pool_id    = string
    on_boot    = bool
    started    = bool
    cores      = number
    memory_mib = number
    disk_gib   = number
    # Outside the DHCP pool (.200-.249) and the Talos, VIP and gateway
    # addresses. UniFi gets a reservation for mac_address and a local record
    # workspace.<zone> for it (a separate, manual step).
    ip          = string
    mac_address = string
    username    = string
    # Key type and base64 only: the file's comment field stays out of Git.
    ssh_public_keys = list(string)
    # Ubuntu 26.04 release-20261016 cloud image, copied by hand to
    # /var/lib/vz/import/ (storage `local` needs `import` content).
    image_file_id = string
    # snippets/workspace-vendor.yaml, copied by hand to /var/lib/vz/snippets/
    # (storage `local` needs `snippets` content). ForceNew: never rename it.
    vendor_data_file_id = string
  })
  default = {
    vm_id               = 401
    name                = "workspace"
    pool_id             = "workspace"
    on_boot             = true
    started             = true
    cores               = 6
    memory_mib          = 8192
    disk_gib            = 96
    ip                  = "192.168.10.30"
    mac_address         = "BC:24:11:9A:38:51"
    username            = "mihir"
    ssh_public_keys     = ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJCnTnMZBEsj9ud0lLtw4UyDNpZYgwLnWt5lBQmbkc85"]
    image_file_id       = "local:import/ubuntu-26.04-server-cloudimg-amd64-20261016.qcow2"
    vendor_data_file_id = "local:snippets/workspace-vendor.yaml"
  }
}
