resource "proxmox_virtual_environment_vm" "talos" {
  for_each = var.nodes

  name        = each.key
  node_name   = var.proxmox_node
  vm_id       = each.value.vm_id
  pool_id     = var.pool_id
  description = "Talos Kubernetes node (control plane + workloads). Managed by Terraform in homelab/terraform."
  tags        = ["kubernetes", "talos", "terraform"]

  on_boot         = true
  started         = var.start_vms
  stop_on_destroy = true

  # Start after TrueNAS (VM 999, order 1) so NFS/iSCSI storage is up first.
  startup {
    order    = 2
    up_delay = 30
  }

  machine       = "q35"
  bios          = "seabios"
  scsi_hardware = "virtio-scsi-single"

  operating_system {
    type = "l26"
  }

  # Needs the qemu-guest-agent system extension in the Talos image.
  agent {
    enabled = true
    trim    = true
  }

  cpu {
    cores = each.value.cores
    type  = "host"
  }

  # Fixed memory: no ballooning for Kubernetes nodes.
  memory {
    dedicated = each.value.memory_mib
    floating  = 0
  }

  disk {
    datastore_id = var.vm_datastore
    interface    = "scsi0"
    size         = each.value.disk_gib
    file_format  = "raw"
    iothread     = true
    discard      = "on"
    ssd          = true
  }

  dynamic "cdrom" {
    for_each = var.talos_iso_file_id == null ? [] : [var.talos_iso_file_id]
    content {
      file_id   = cdrom.value
      interface = "ide2"
    }
  }

  boot_order = var.talos_iso_file_id == null ? ["scsi0"] : ["scsi0", "ide2"]

  # GPU passthrough (Jellyfin/NVENC). q35 + pcie. The GTX 1650 is Hobbes's only
  # display, so the host console goes dark while this VM runs.
  dynamic "hostpci" {
    for_each = each.value.gpu_mapping == null ? [] : [each.value.gpu_mapping]
    content {
      device  = "hostpci0"
      mapping = hostpci.value
      pcie    = true
      rombar  = true
      xvga    = false
    }
  }

  network_device {
    bridge      = var.bridge
    vlan_id     = var.vlan_id
    model       = "virtio"
    mac_address = each.value.mac_address
  }
}
