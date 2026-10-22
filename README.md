<div align="center">

<img src="https://camo.githubusercontent.com/5b298bf6b0596795602bd771c5bddbb963e83e0f/68747470733a2f2f692e696d6775722e636f6d2f7031527a586a512e706e67" align="center" width="144px" height="144px"/>

### My Kubernetes Lab cluster ⛵️

_... managed with Flux and Renovate_ :robot:

</div>

<br/>

<div align="center">

[![talos](https://img.shields.io/badge/talos-v1.14.4-brightgreen?style=for-the-badge&logo=talos&logoColor=white)](https://www.talos.dev/)
[![renovate](https://img.shields.io/badge/renovate-enabled-brightgreen?style=for-the-badge&logo=renovatebot&logoColor=white)](https://github.com/renovatebot/renovate)

</div>

---

## 📖 Overview

This is home to my personal Kubernetes lab cluster. [Flux](https://github.com/fluxcd/flux2) watches this Git repository
and makes the changes to my cluster based on the manifests in the [kubernetes](./kubernetes/)
directory. [Renovate](https://github.com/renovatebot/renovate) also watches this Git repository and creates pull
requests when it finds updates to Docker images, Helm charts, and other dependencies.

---

## ⛵ Kubernetes

I used the [onedr0p/flux-cluster-template](https://github.com/onedr0p/flux-cluster-template) as a starting point for my
cluster.

### Installation

The cluster is being rebuilt as three [Talos](https://www.talos.dev/) VMs on Proxmox, from the current
[onedr0p/cluster-template](https://github.com/onedr0p/cluster-template): Terraform (`terraform/`, `bpg/proxmox`) creates
the VMs, [topf](https://postfinance.github.io/topf/) applies the Talos config in `talos/`, and Flux reconciles
`kubernetes/`. Tooling is pinned with [mise](https://mise.jdx.dev/) and driven by `just` (`just configure`,
`just bootstrap talos`, `just bootstrap apps`). The previous k3s/Ansible setup is kept in `archive/k3s/`.

### Core Components

- [cilium](https://cilium.io/): Networking, kube-proxy replacement and LoadBalancer IPs (L2 announcements)
- [envoy-gateway](https://gateway.envoyproxy.io/): Gateway API ingress
- [k8s-gateway](https://github.com/k8s-gateway/k8s_gateway): Internal DNS for cluster hostnames
- [cert-manager](https://cert-manager.io/docs/): Certificates
- [spegel](https://github.com/spegel-org/spegel): Peer-to-peer image mirror
- [sops](https://github.com/getsops/sops): Encrypted secrets for Kubernetes, Talos and Terraform, committed to Git

### GitOps

[Flux](https://github.com/fluxcd/flux2) watches my [kubernetes](./kubernetes) folder (see Directories below) and makes
the changes to my cluster based on the YAML manifests.

[Renovate](https://github.com/renovatebot/renovate) watches my **entire** repository looking for dependency updates,
when they are found a PR is automatically created. When some PRs are merged [Flux](https://github.com/fluxcd/flux2)
applies the changes to my cluster.

---

## 🔧 Hardware

| Device                    | Processor                      | Ram    | OS Disk Size | Data Disks                                | Operating System | Purpose                   |
| ------------------------- | ------------------------------ | ------ | ------------ | ----------------------------------------- | ---------------- | ------------------------- |
| Dell Precision Tower 9710 | 2 x Intel Xeon CPU E5-2687W v4 | 128 GB | 2TB NVME     | 6 x 4TB HDD / 2 x 8TB HDD / 1 x 240GB SSD | Debian 11 (PVE)  | Virtualization Host / NAS |
| Dell Optiplex 5050        | 1 x Intel Core i5-7600T        | 32GB   | 256GB NVMe   | -                                         | Debian 11 (PVE)  | Virtualization Host       |
| Dell Optiplex 5060        | 1 x Intel Core i5-8500T        | 32GB   | 256GB NVMe   | -                                         | Debian 11 (PVE)  | Virtualization Host       |
| Raspberry Pi 4 Model B    | 1 x Broadcom BCM2711           | 8GB    | 64GB SD Card | -                                         | Raspbian         | Misc                      |
| TP-Link TL-SG105          | -                              | -      | -            | -                                         | -                | Network Switch            |

## 🔨Cluster Rebuild Counter

| Times Rebuilt | Last Updated |
| ------------- | ------------ |
| **13**        | 10/21/2026   |

## 🤝 Acknowledgements

A lot of inspiration for my cluster comes from the people that have shared their clusters using
the [k8s-at-home](https://github.com/topics/k8s-at-home) GitHub topic and
the [Kubernetes@Home search](https://nanne.dev/k8s-at-home-search/) .

## 🔏 License

See [LICENSE](./LICENSE)
