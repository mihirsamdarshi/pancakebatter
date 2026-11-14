set quiet
set shell := ['bash', '-euo', 'pipefail', '-c']
set script-interpreter := ['bash', '-euo', 'pipefail']
set default-list
set default-script

# Run as `just workspace <recipe>` (root justfile: mod? workspace). Recipes run
# in this directory. Every Terraform call except init goes through two nested
# `sops exec-env` processes: ../proxmox.sops.env (the Proxmox token, shared with
# the Talos root) and workspace.sops.env (TF_VAR_zone). Both live only in the
# environment of that one process and never touch disk in plaintext.

[doc('Initialize the providers (once per clone)')]
[group('workspace')]
init:
    terraform init -input=false

# -detailed-exitcode: 0 = no changes, 2 = changes pending (just reports it
# as a failure), 1 = error. Read every plan for `started` changes and for any
# replacement of the workspace VM.
[doc('Show pending workspace VM changes (exit code 2 means drift)')]
[group('workspace')]
plan:
    sops exec-env ../proxmox.sops.env \
        'sops exec-env workspace.sops.env "terraform plan -input=false -detailed-exitcode"'

# The plan is saved and shown first, then the prompt, and apply uses exactly
# that saved plan. sops exec-env passes the plan's exit code through.
[doc('Plan, confirm, then apply exactly that plan to Proxmox')]
[group('workspace')]
apply:
    trap 'rm -f plan.out' EXIT
    rc=0
    sops exec-env ../proxmox.sops.env \
        'sops exec-env workspace.sops.env "terraform plan -input=false -detailed-exitcode -out=plan.out"' || rc=$?
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
    sops exec-env ../proxmox.sops.env \
        'sops exec-env workspace.sops.env "terraform apply -input=false plan.out"'
