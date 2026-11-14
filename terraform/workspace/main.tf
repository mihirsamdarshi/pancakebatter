resource "proxmox_virtual_environment_vm" "workspace" {
  name        = var.workspace.name
  node_name   = var.proxmox_node
  vm_id       = var.workspace.vm_id
  pool_id     = var.workspace.pool_id
  description = "Ubuntu 26.04 workspace VM (shell, coding, builds). Managed by Terraform in homelab/terraform/workspace."
  # Creating a VM with tags needs VM.Config.Options on /vms/401 itself: Proxmox
  # checks tags before the VM joins the pool (same ACL trap as 301-303).
  tags = ["workspace", "ubuntu", "terraform"]

  # Own flags, not the Talos ones: a Talos-only change can never start, stop or
  # re-flag this VM.
  on_boot         = var.workspace.on_boot
  started         = var.workspace.started
  stop_on_destroy = true
  # Never reboot the running guest to apply a change; restarts are a separate,
  # owner-approved step.
  reboot_after_update = false

  # The disk holds work and nothing backs it up. Several fields force a
  # replacement (vendor_data_file_id, vm_id, node_name, initialization.type),
  # so any plan that would destroy the VM fails here, and Proxmox itself
  # refuses to remove a protected VM or its disks. Lifting both is a reviewed
  # change of its own.
  protection = true
  lifecycle {
    prevent_destroy = true
  }

  # No `startup` block: setting it needs Sys.Modify on / (host-wide), which this
  # token deliberately lacks. Unordered VMs start after ordered ones, so TrueNAS
  # (VM 999, order 1) still boots first.

  machine       = "q35"
  bios          = "seabios"
  scsi_hardware = "virtio-scsi-single"

  operating_system {
    type = "l26"
  }

  # The cloud image has no qemu-guest-agent; the vendor-data snippet installs
  # and starts it on first boot. If the agent never reports, Terraform gives up
  # after 5 minutes with a warning (the default 15 minutes would also stall every
  # later plan of this root).
  agent {
    enabled = true
    trim    = true
    timeout = "5m"
    wait_for_ip {
      ipv4 = true
    }
  }

  cpu {
    cores = var.workspace.cores
    type  = "host"
  }

  # Fixed memory, no ballooning (same as the Talos VMs). Changing it later
  # needs a guest restart.
  memory {
    dedicated = var.workspace.memory_mib
    floating  = 0
  }

  # import_from, not file_id: file_id imports over SSH, and this provider has no
  # SSH access to Hobbes. import_from uses the API but needs a volume with
  # `import` content (.qcow2 name). The provider grows the 3.5 GiB image to
  # `size` after the import, and ignores import_from after creation, so
  # deleting or replacing the image file later changes nothing here.
  disk {
    datastore_id = var.vm_datastore
    interface    = "scsi0"
    import_from  = var.workspace.image_file_id
    size         = var.workspace.disk_gib
    file_format  = "raw"
    iothread     = true
    discard      = "on"
    ssd          = true
  }

  boot_order = ["scsi0"]

  # The image logs boot and cloud-init to ttyS0 (`qm terminal 401` on Hobbes).
  # The default VGA stays, so the noVNC console works too.
  serial_device {}

  # Proxmox generates the user-data (user, key, network) from this block. A
  # change to these fields or to the VM name gives the guest a new instance-id,
  # so it re-runs first boot at its next start.
  initialization {
    datastore_id = var.vm_datastore
    # No package upgrade on first boot, so the agent comes up quickly. Upgrades
    # and the restart after them are done by hand. The provider docs call this
    # root-only, but PVE 9.2 checks VM.Config.Cloudinit, which the token has.
    upgrade = false

    # Without a domain the guest inherits Hobbes's old search domain.
    dns {
      domain  = var.zone
      servers = [var.gateway]
    }

    ip_config {
      ipv4 {
        address = "${var.workspace.ip}/${var.prefix_length}"
        gateway = var.gateway
      }
    }

    # No password: SSH keys only.
    user_account {
      username = var.workspace.username
      keys     = var.workspace.ssh_public_keys
    }

    # ForceNew: never rename this file, only edit it in place (and copy it to
    # Hobbes again). The VM reads it at every start, so it must stay there.
    vendor_data_file_id = var.workspace.vendor_data_file_id
  }

  network_device {
    bridge      = var.bridge
    vlan_id     = var.vlan_id
    model       = "virtio"
    mac_address = var.workspace.mac_address
  }
}
