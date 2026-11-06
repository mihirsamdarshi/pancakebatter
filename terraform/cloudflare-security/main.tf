# Cloudflare security settings for the zone, managed with the shared
# Terraform-only user token (1Password `Cloudflare User API Token`, the same
# token terraform/dns uses; cloudflare.sops.env here). Run it through its just
# recipes (mod.just): `just csec init|entrypoint|import|plan|apply`.
#
# The token has four zone-scoped permissions on the one zone: Zone Read, DNS
# Edit, Zone WAF Edit and Bot Management Edit. This root needs only Zone Read,
# Zone WAF Edit and Bot Management Edit. The cluster's cert-manager uses a
# separate account token, which is never used here.
provider "cloudflare" {}

variable "zone" {
  description = "Cloudflare zone (the public domain). Set via TF_VAR_zone from cloudflare.sops.env."
  type        = string
}

variable "ruleset_name" {
  description = "Name of the zone's existing custom-rule entrypoint ruleset. In provider 5.28.1 a different name forces replacement, so it must equal what `just csec entrypoint` prints. Cloudflare names a new one \"default\"."
  type        = string
  default     = "default"
}

data "cloudflare_zone" "this" {
  filter = {
    name = var.zone
  }
}

# GitHub's webhook source ranges, read at every plan, so a plain re-plan keeps
# the rule current. If GitHub changes them, the plan shows ONE in-place change
# to the rule's expression, which the person applying reviews. If the request
# fails or the answer looks wrong, the plan fails and nothing changes.
data "http" "github_meta" {
  url = "https://api.github.com/meta"
  request_headers = {
    Accept                 = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
  }
  lifecycle {
    postcondition {
      condition     = self.status_code == 200
      error_message = "api.github.com/meta did not return 200; the hooks list was not read."
    }
  }
}

locals {
  flux_webhook_host = "flux-webhook.${var.zone}"
  github_hooks      = sort(distinct(try(jsondecode(data.http.github_meta.response_body).hooks, [])))

  # Every custom rule that already exists in the zone, copied here BEFORE the
  # first plan (mod.just `entrypoint` prints them). Each entry needs the rule's
  # existing id as `ref`, so it is kept, not recreated. Empty only when
  # `entrypoint` showed no rules or no entrypoint (404).
  carried_rules = []

  flux_webhook_rule = {
    ref         = "flux_webhook_github_only"
    description = "flux-webhook: block everything except GitHub's webhook ranges"
    expression  = "(http.host eq \"${local.flux_webhook_host}\" and not ip.src in {${join(" ", local.github_hooks)}})"
    action      = "block"
    enabled     = true
  }
}

# This resource owns the WHOLE http_request_firewall_custom phase of the zone:
# a rule made by hand that is not listed here is deleted by apply. Gate in
# mod.just: `plan` refuses to run until the entrypoint is imported into state,
# and `check` fails the plan if any rule would be removed.
resource "cloudflare_ruleset" "custom" {
  zone_id     = data.cloudflare_zone.this.zone_id
  name        = var.ruleset_name
  description = "Zone custom rules; managed by terraform/cloudflare-security"
  kind        = "zone"
  phase       = "http_request_firewall_custom"
  rules       = concat(local.carried_rules, [local.flux_webhook_rule])

  lifecycle {
    prevent_destroy = true
    precondition {
      # An empty or reshaped list would turn the rule into "block every
      # request to the host", so refuse anything that is not clearly a list.
      condition     = length(local.github_hooks) >= 5
      error_message = "GitHub returned fewer than 5 hooks ranges; refusing to build the rule."
    }
    precondition {
      condition     = alltrue([for c in local.github_hooks : can(cidrhost(c, 0))])
      error_message = "A hooks entry is not a valid CIDR; refusing to build the rule."
    }
    precondition {
      condition     = length([for c in local.github_hooks : c if !strcontains(c, ":")]) >= 1 && length([for c in local.github_hooks : c if strcontains(c, ":")]) >= 1
      error_message = "The hooks list needs at least one IPv4 and one IPv6 range; refusing to build the rule."
    }
  }
}

# Bot Fight Mode off: on the Free plan a rule cannot skip it, and it can
# challenge GitHub's webhook deliveries and eBay's notifications. Import the
# existing settings first (mod.just `import`), so the plan shows only this
# change.
resource "cloudflare_bot_management" "this" {
  zone_id    = data.cloudflare_zone.this.zone_id
  fight_mode = false
}
