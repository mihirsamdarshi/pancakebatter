# Cloudflare Access login for the reports share (share.<zone>): one-time PIN
# by email, for the guests listed in reports_share_guest_emails and nobody else.
# The DNS record is in main.tf. The routing is in
# kubernetes/apps/personal-apps/reports-share.
#
# Needs these token permissions, both at the account level, on top of the
# DNS ones (newer dashboards show "Edit" as "Write"):
#   Access: Apps and Policies Edit
#   Access: Identity Providers Edit
# The Zero Trust organization (the team name and the Free plan) must already
# exist: this root neither creates nor reads it. The team name is the part of
# the team domain before .cloudflareaccess.com (Zero Trust, Settings, General).
#
# Everything here exists only when reports_share_tunnel_id is set AND
# reports_share_guest_emails is not empty. With either unset the plan is empty.
#
# An account can have only ONE one-time PIN login method. A new Zero Trust
# organization may already have it. If the create fails with "already exists",
# import the existing one, then plan again. Find the ID in Zero Trust,
# Settings, Authentication, Login methods, or from the API
# (GET /accounts/<account_id>/access/identity_providers), then run from
# terraform/dns:
#   sops exec-env cloudflare.sops.env 'terraform import "cloudflare_zero_trust_access_identity_provider.reports_share_otp[0]" accounts/<account_id>/<identity_provider_id>'

variable "reports_share_guest_emails" {
  description = "Email addresses allowed through the Access login of share.<zone>. Empty creates no Access resources. Set it in the git-ignored terraform/dns/tunnel.auto.tfvars; the addresses must never enter Git."
  type        = list(string)
  default     = []
  sensitive   = true
  validation {
    condition     = alltrue([for e in var.reports_share_guest_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "Every entry of reports_share_guest_emails must look like an email address."
  }
}

locals {
  # nonsensitive(): only the yes/no leaves the list, not an address. count
  # cannot take a sensitive value.
  reports_share_access = var.reports_share_tunnel_id != null && nonsensitive(length(var.reports_share_guest_emails) > 0)

  # Must match SHARE_HOST in kubernetes/apps/flux-system/app-platform/apps/reports.yaml.
  reports_share_host = "share.${var.zone}"
}

# The account's one-time PIN login method (the emailed code).
resource "cloudflare_zero_trust_access_identity_provider" "reports_share_otp" {
  count      = local.reports_share_access ? 1 : 0
  account_id = data.cloudflare_zone.this.account.id
  name       = "One-time PIN"
  type       = "onetimepin"
  config     = {}
}

# Allow only the listed emails: one email include each, nothing else (no
# domain, no everyone, no group). Anyone else is denied.
resource "cloudflare_zero_trust_access_policy" "reports_share_guests" {
  count      = local.reports_share_access ? 1 : 0
  account_id = data.cloudflare_zone.this.account.id
  name       = "reports-share guests"
  decision   = "allow"
  include    = [for e in var.reports_share_guest_emails : { email = { email = e } }]
}

# The whole host (no path), self-hosted. cloudflared checks this application's
# AUD tag (output reports_share_access_aud) on every request.
resource "cloudflare_zero_trust_access_application" "reports_share" {
  count                     = local.reports_share_access ? 1 : 0
  account_id                = data.cloudflare_zone.this.account.id
  name                      = "reports-share"
  type                      = "self_hosted"
  domain                    = local.reports_share_host
  session_duration          = "24h"
  allowed_idps              = [cloudflare_zero_trust_access_identity_provider.reports_share_otp[0].id]
  auto_redirect_to_identity = true
  app_launcher_visible      = false
  policies                  = [{ id = cloudflare_zero_trust_access_policy.reports_share_guests[0].id }]
}

# For cluster-secrets: SECRET_SHARE_ACCESS_AUD. It is not a credential, and the
# state is local to this machine. SECRET_SHARE_ACCESS_TEAM is not an output: see
# the team name note at the top.
output "reports_share_access_aud" {
  description = "AUD tag of the Access application (SECRET_SHARE_ACCESS_AUD). Null while the share is off."
  value       = one(cloudflare_zero_trust_access_application.reports_share[*].aud)
}
