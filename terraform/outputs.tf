output "nodes" {
  description = "Talos node VM IDs, MACs and planned addresses (for DHCP reservations and Talos config)."
  value = {
    for name, vm in proxmox_virtual_environment_vm.talos : name => {
      vm_id       = vm.vm_id
      mac_address = try(vm.network_device[0].mac_address, null)
      planned_ip  = var.nodes[name].ip
    }
  }
}

output "network" {
  description = "Planned node network settings (null until chosen)."
  value       = var.network
}
