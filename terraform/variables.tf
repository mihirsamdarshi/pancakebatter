variable "proxmox_node" {
  description = "Proxmox node that hosts the Talos VMs."
  type        = string
  default     = "hobbes"
}

variable "pool_id" {
  description = "Proxmox resource pool; the Terraform token's VM rights are scoped to it."
  type        = string
  default     = "talos"
}

variable "vm_datastore" {
  description = "Datastore for VM system/etcd disks (local NVMe, independent of TrueNAS)."
  type        = string
  default     = "local-lvm"
}

variable "talos_iso_file_id" {
  description = "Talos install ISO already uploaded to Proxmox, e.g. \"local:iso/talos-v1.x.y-metal-amd64.iso\" (factory image with the qemu-guest-agent extension). Null leaves the VMs without install media."
  type        = string
  default     = null
}

variable "start_vms" {
  description = "Start the VMs after creation."
  type        = bool
  default     = false
}

# --- Networking: not settled yet (see docs/agents/unifi-network-plan.md). Keep configurable. ---

variable "bridge" {
  description = "Linux bridge for the node NICs."
  type        = string
  default     = "vmbr0"
}

variable "vlan_id" {
  description = "VLAN tag for the node NICs, or null for untagged. Requires a VLAN-aware bridge and a tagged upstream port."
  type        = number
  default     = null
}

variable "network" {
  description = "Node addressing, consumed by the Talos/cluster-template config rather than by Proxmox. All null until the server network is chosen."
  type = object({
    prefix_length = optional(number)
    gateway       = optional(string)
    dns_servers   = optional(list(string), [])
    api_vip       = optional(string)
  })
  default = {}
}

variable "nodes" {
  description = "Talos nodes. Each runs control-plane services and workloads."
  type = map(object({
    vm_id       = number
    cores       = optional(number, 4)
    memory_mib  = optional(number, 12288)
    disk_gib    = optional(number, 128)
    ip          = optional(string)
    mac_address = optional(string)
    # Proxmox PCI resource mapping to pass through (all functions, PCIe). The token
    # only has Mapping.Use on /mapping/pci/gtx1650. That node needs the NVIDIA Talos
    # extensions in its schematic (see docs/agents/kubernetes-rebuild.md).
    gpu_mapping = optional(string)
  }))
  default = {
    "talos-01" = { vm_id = 301, gpu_mapping = "gtx1650" }
    "talos-02" = { vm_id = 302 }
    "talos-03" = { vm_id = 303 }
  }
}
