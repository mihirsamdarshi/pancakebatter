<div align="center">

<img src="https://camo.githubusercontent.com/5b298bf6b0596795602bd771c5bddbb963e83e0f/68747470733a2f2f692e696d6775722e636f6d2f7031527a586a512e706e67" align="center" width="144px" height="144px"/>

### My Kubernetes Lab cluster ⛵️

_... managed with Flux and Renovate_ :robot:

</div>

<br/>

<div align="center">

[![k3s](https://img.shields.io/badge/k3s-v1.27.2-brightgreen?style=for-the-badge&logo=kubernetes&logoColor=white)](https://k3s.io/)
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

My cluster is [k3s](https://k3s.io/) provisioned overtop Ubuntu Proxmox VMs using
the [Ansible](https://www.ansible.com/) galaxy role [ansible-role-k3s](https://github.com/PyratLabs/ansible-role-k3s).
This is a semi hyper-converged cluster, workloads are sharing the same available resources on my nodes while I have a
separate VM running TrueNAS Scale for data storage.

🔸 [Click here](./ansible) to see my Ansible playbooks and roles._

### Core Components

- [kube-vip](https://kube-vip.io/): Announces the kubeserver api via BGP
- [metallb](https://metallb.universe.tf/): Announces loadbalancers via BGP
- [cert-manager](https://cert-manager.io/docs/): Creates SSL certificates for services in my Kubernetes cluster
- [external-dns](https://github.com/kubernetes-sigs/external-dns): Automatically manages DNS records from my cluster in
  a cloud DNS provider
- [k8s-gateway](https://gateway-api.sigs.k8s.io/): Runs a separate internal-only DNS zone for some services
- [ingress-nginx](https://github.com/kubernetes/ingress-nginx/): Ingress controller to expose HTTP traffic to pods over
  DNS
- [sops](https://toolkit.fluxcd.io/guides/mozilla-sops/): Managed secrets for Kubernetes, Ansible and Terraform which
  are commited to Git
- [cilium](https://cilium.io/): Provides networking, security, and observability
- [rook-ceph](https://rook.io/): Provides block, object, and file storage

### GitOps

[Flux](https://github.com/fluxcd/flux2) watches my [kubernetes](./kubernetes) folder (see Directories below) and makes
the changes to my cluster based on the YAML manifests.

[Renovate](https://github.com/renovatebot/renovate) watches my **entire** repository looking for dependency updates,
when they are found a PR is automatically created. When some PRs are merged [Flux](https://github.com/fluxcd/flux2)
applies the changes to my cluster.

---

## 🔧 Hardware

| Device                    | Processor                      | Ram    | OS Disk Size | Data Disks                                | Operating System | Purpose                   |
|---------------------------|--------------------------------|--------|--------------|-------------------------------------------|------------------|---------------------------|
| Dell Precision Tower 9710 | 2 x Intel Xeon CPU E5-2687W v4 | 128 GB | 2TB NVME     | 6 x 4TB HDD / 2 x 8TB HDD / 1 x 240GB SSD | Debian 11 (PVE)  | Virtualization Host / NAS |
| Dell Optiplex 5050        | 1 x Intel Core i5-7600T        | 32GB   | 256GB NVMe   | -                                         | Debian 11 (PVE)  | Virtualization Host       |
| Dell Optiplex 5060        | 1 x Intel Core i5-8500T        | 32GB   | 256GB NVMe   | -                                         | Debian 11 (PVE)  | Virtualization Host       |
| Raspberry Pi 4 Model B    | 1 x Broadcom BCM2711           | 8GB    | 64GB SD Card | -                                         | Raspbian         | Misc                      |
| TP-Link TL-SG105          | -                              | -      | -            | -                                         | -                | Network Switch            |

## 🔨Cluster Rebuild Counter


| Times Rebuilt | Last Updated |
|---------------|--------------|
| **12**        | 7/15/2023    |


## 🤝 Acknowledgements

A lot of inspiration for my cluster comes from the people that have shared their clusters using
the [k8s-at-home](https://github.com/topics/k8s-at-home) GitHub topic and
the [Kubernetes@Home search](https://nanne.dev/k8s-at-home-search/) .

## 🔏 License

See [LICENSE](./LICENSE)
