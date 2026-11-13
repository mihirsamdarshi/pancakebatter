output "workspace" {
  description = "Workspace VM ID, MAC and planned address (for the DHCP reservation and the local DNS record)."
  value = {
    vm_id       = proxmox_virtual_environment_vm.workspace.vm_id
    mac_address = try(proxmox_virtual_environment_vm.workspace.network_device[0].mac_address, null)
    planned_ip  = var.workspace.ip
  }
}
