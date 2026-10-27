set quiet
set minimum-version := '1.55.1'
set default-list
set default-script
set shell := ['bash', '-euo', 'pipefail', '-c']
set script-interpreter := ['bash', '-euo', 'pipefail']

[group('bootstrap')]
mod? bootstrap 'bootstrap'

[group('kubernetes')]
mod? kube 'kubernetes'

[group('talos')]
mod? talos 'talos'

[group('vms')]
mod? vms 'terraform'

[group('dns')]
mod? dns 'terraform/dns'

[group('tailscale')]
mod? tailscale 'kubernetes/apps/tailscale'

[doc('Check the local agent notes in docs/agents (front matter, freshness, links)')]
[group('docs')]
docs-check *args:
    if [[ -x docs/agents/scripts/docs-check.py ]]; then docs/agents/scripts/docs-check.py {{ args }}; else echo "docs/agents is not present in this checkout" >&2; fi

[private]
log lvl msg *args:
    gum log -t rfc3339 -s -l "{{ lvl }}" "{{ msg }}" {{ args }}

# === template ===

[group('template')]
mod template 'template'

[doc('Render and validate configuration files')]
[group('template')]
configure:
    just template configure

[doc('Initialize configuration files (cluster.toml, age key, deploy key, webhook token)')]
[group('template')]
init:
    just template init
