# Server network selected October 19, 2026. Private DNS: samdarshi.net.
# These settings prepare the stopped VMs; Talos machine config is separate.
bridge        = "vmbr0"
vlan_id       = 10
start_vms     = false
start_on_boot = false

network = {
  prefix_length = 24
  gateway       = "192.168.10.1"
  dns_servers   = ["192.168.10.1"]
  api_vip       = "192.168.10.100"
}

nodes = {
  talos-01 = {
    vm_id       = 301
    ip          = "192.168.10.21"
    mac_address = "BC:24:11:D1:26:24"
    gpu_mapping = "gtx1650"
  }
  talos-02 = {
    vm_id       = 302
    ip          = "192.168.10.22"
    mac_address = "BC:24:11:68:48:41"
  }
  talos-03 = {
    vm_id       = 303
    ip          = "192.168.10.23"
    mac_address = "BC:24:11:25:5F:7B"
  }
}
