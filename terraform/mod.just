set quiet
set shell := ['bash', '-euo', 'pipefail', '-c']
set script-interpreter := ['bash', '-euo', 'pipefail']
set default-list
set default-script

# Recipes run in this directory. Every Terraform call except init goes
# through `sops exec-env`, so the Proxmox token lives only in the environment
# of that one process and never touches disk in plaintext.

[doc('Initialize the providers (once per clone)')]
[group('vms')]
init:
    terraform init -input=false

# -detailed-exitcode: 0 = no changes, 2 = changes pending (just reports it
# as a failure), 1 = error. network.auto.tfvars overrides variable defaults,
# so read every plan for `started` changes.
[doc('Show pending Proxmox VM changes (exit code 2 means drift)')]
[group('vms')]
plan:
    sops exec-env proxmox.sops.env 'terraform plan -input=false -detailed-exitcode'

# The plan is saved and shown first, then the prompt, and apply uses exactly
# that saved plan. sops exec-env passes the plan's exit code through.
[doc('Plan, confirm, then apply exactly that plan to Proxmox')]
[group('vms')]
apply:
    trap 'rm -f plan.out' EXIT
    rc=0
    sops exec-env proxmox.sops.env \
        'terraform plan -input=false -detailed-exitcode -out=plan.out' || rc=$?
    case "$rc" in
        0)
            just log info "No changes"
            exit 0
            ;;
        2) ;;
        *) exit "$rc" ;;
    esac
    [[ -t 0 && -t 1 ]] || { just log error "apply needs an interactive terminal"; exit 1; }
    rc=0; gum confirm --default=false 'Apply plan.out to Proxmox?' || rc=$?
    case "$rc" in 0) ;; 1|130) just log warn "Apply cancelled"; exit 0 ;; *) exit "$rc" ;; esac
    sops exec-env proxmox.sops.env 'terraform apply -input=false plan.out'
