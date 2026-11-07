# Cloudflare Access login for the reports share (share.<zone>): one-time PIN
# by email, for the guests in the policy "reports-share guests" and nobody else.
# reports_share_guest_emails is the first guest list, used when the policy is
# created. After that the owner keeps the list in the dashboard (Zero Trust,
# Access, Policies, "reports-share guests") and Terraform ignores it.
# The routing is in kubernetes/apps/personal-apps/reports-share.
#
# Gates. The Access application, its policy and the proxied CNAME in main.tf
# exist only when reports_share_tunnel_id is set AND reports_share_guest_emails
# is not empty. The CNAME depends on the application, so the name is created
# after it and destroyed before it: share.<zone> never routes to the tunnel
# without Access in front. The one-time PIN login method is account-wide and
# does not depend on the emails: it exists whenever reports_share_tunnel_id is
# set, unless reports_share_otp_idp_id supplies one. With the tunnel ID unset,
# the plan is empty.
#
# Token permissions, both at the account level, on top of the DNS ones (the
# dashboard calls them Edit, the API docs call them Write), with Account
# Resources including your account:
#   Access: Apps and Policies Edit
#   Access: Identity Providers Edit
# The token is shared with terraform/cloudflare-security; that is accepted on
# purpose.
# The Zero Trust organization (the team name and the Free plan) must already
# exist: this root neither creates nor reads it. The team name is the part of
# the team domain before .cloudflareaccess.com (Zero Trust, Settings, General).
#
# Fallback for the login method. An account may have only ONE one-time PIN
# method. If creating it fails with an auth error (the token's "Identity
# Providers" permission is not accepted for it; the API lists the combined
# "Access: Organizations, Identity Providers, and Groups Write") or because the
# account already has One-time PIN, turn it on once in the dashboard (Zero
# Trust, Integrations, Identity providers, Add new, One-time PIN), copy its ID
# and set reports_share_otp_idp_id in tunnel.auto.tfvars. Terraform then
# creates no method and the application uses that ID. Never use prevent_destroy.
#
# Importing after a partly failed apply. <account_id> is in the dashboard URL
# (dash.cloudflare.com/<account_id>/...). Run from terraform/dns, then plan:
#   sops exec-env cloudflare.sops.env 'terraform import "cloudflare_zero_trust_access_identity_provider.reports_share_otp[0]" accounts/<account_id>/<identity_provider_id>'
#   sops exec-env cloudflare.sops.env 'terraform import "cloudflare_zero_trust_access_policy.reports_share_guests[0]" <account_id>/<policy_id>'
#   sops exec-env cloudflare.sops.env 'terraform import "cloudflare_zero_trust_access_application.reports_share[0]" accounts/<account_id>/<app_id>'
#   sops exec-env cloudflare.sops.env 'terraform import "cloudflare_dns_record.reports_share[0]" <zone_id>/<record_id>'
# Then the plan shows only what the failed apply did not create.

variable "reports_share_otp_idp_id" {
  description = "ID of an existing One-time PIN login method. Null makes this root create one when reports_share_tunnel_id is set. See the fallback note at the top of access.tf."
  type        = string
  default     = null
}

variable "reports_share_guest_emails" {
  description = "The first email addresses allowed through the Access login of share.<zone>, used only when the policy is created; after that the list is kept in the dashboard. It is also the switch: empty creates no Access application, policy or record (and removes them). Set it in the git-ignored terraform/dns/tunnel.auto.tfvars; the addresses must never enter Git. A validation error prints the tfvars line, so do not paste it anywhere."
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

  # The login method: the supplied one, else the one this root creates.
  reports_share_otp_idp_id = var.reports_share_otp_idp_id != null ? var.reports_share_otp_idp_id : one(cloudflare_zero_trust_access_identity_provider.reports_share_otp[*].id)

  # Must match SHARE_HOST in kubernetes/apps/flux-system/app-platform/apps/reports.yaml.
  reports_share_host = "share.${var.zone}"
}

# The account's one-time PIN login method (the emailed code).
resource "cloudflare_zero_trust_access_identity_provider" "reports_share_otp" {
  count      = var.reports_share_tunnel_id != null && var.reports_share_otp_idp_id == null ? 1 : 0
  account_id = data.cloudflare_zone.this.account.id
  name       = "One-time PIN"
  type       = "onetimepin"
  config     = {}
}

# Allow only the listed emails: one email include each, nothing else (no
# domain, no everyone, no group). Anyone else is denied. Terraform sets the
# list when it creates the policy and then ignores it, so the owner can add and
# remove guests in the dashboard without an apply undoing it. Only add single
# emails there: never a domain, "Everyone" or another rule, which Terraform
# would not notice.
resource "cloudflare_zero_trust_access_policy" "reports_share_guests" {
  count      = local.reports_share_access ? 1 : 0
  account_id = data.cloudflare_zone.this.account.id
  name       = "reports-share guests"
  decision   = "allow"
  include    = [for e in var.reports_share_guest_emails : { email = { email = e } }]

  lifecycle {
    ignore_changes = [include]
  }
}

# The whole host (no path), self-hosted. The CNAME in main.tf depends on it. cloudflared checks this application's
# AUD tag (output reports_share_access_aud) on every request.
resource "cloudflare_zero_trust_access_application" "reports_share" {
  count                     = local.reports_share_access ? 1 : 0
  account_id                = data.cloudflare_zone.this.account.id
  name                      = "reports-share"
  type                      = "self_hosted"
  domain                    = local.reports_share_host
  session_duration          = "24h"
  allowed_idps              = [local.reports_share_otp_idp_id]
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

# For cluster-secrets, for the share-admin service (the one that edits the
# guest list for the reports app): SECRET_SHARE_ACCESS_APP_ID and
# SECRET_SHARE_ACCESS_POLICY_ID. Both are IDs, not credentials. The state is
# local to this machine. The account ID is not an output: it is in the
# dashboard URL (dash.cloudflare.com/<account_id>/...).
output "reports_share_access_app_id" {
  description = "ID of the Access application (SECRET_SHARE_ACCESS_APP_ID). Null while the share is off."
  value       = one(cloudflare_zero_trust_access_application.reports_share[*].id)
}

output "reports_share_access_policy_id" {
  description = "ID of the guest policy 'reports-share guests' (SECRET_SHARE_ACCESS_POLICY_ID). Null while the share is off."
  value       = one(cloudflare_zero_trust_access_policy.reports_share_guests[*].id)
}
