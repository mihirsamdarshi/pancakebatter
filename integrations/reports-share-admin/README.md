# Reports share-admin

A small service that edits the guest list of the reports share (`share.<zone>`).
It holds the Cloudflare API token, so the reports app does not. The app asks
this service to list guests, replace the list, end all guest sessions and look
up the last sign-in of a guest. Only this service reaches the Cloudflare API.

This is infrastructure outside the personal app platform, like
`integrations/claude-proxy`. This change adds the code and the image only. The
Kubernetes manifests (namespace, Deployment, network policies, the Secret) come
in a later change, as does the platform part that lets the reports app reach it.
The IDs it needs come from the Terraform outputs described in
`kubernetes/apps/personal-apps/README.md`.

The guest list is the `include` list of one Access policy ("reports-share
guests", created by `terraform/dns/access.tf`, which ignores later changes to
`include`). Everything else on the policy stays as it is.

## Routes

The reports app is the only caller (the network policy will enforce that).
Answers are JSON with `cache-control: no-store`.

| Route                    | Result                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `GET /guests`            | `{emails}`: the emails in the policy's include list                                                          |
| `PUT /guests`            | Body `{emails: [...]}`. Replaces the include list with one single-email rule each. `{emails, changed}`       |
| `POST /revoke`           | Asks Cloudflare to end every session of the application (all guests). `{revoked: true}`                      |
| `GET /last-login?email=` | `{email, lastLogin}`: time of the newest allowed Access request of this application by that email, or `null` |
| `POST /notify/invite`    | Body `{email}`. Checked, then 501: notification email is not switched on yet                                 |
| `POST /notify/published` | Body `{collection, titles}` (1 to 10 titles, 120 characters each). Checked, then 501                         |

`GET /healthz` is on its own port, `HEALTH_PORT` (8081), which serves nothing
else: 200 when the token file is readable and not empty, else 503, on any Host,
without a call to Cloudflare. It is not on the service port, so a probe that
reaches the node's address (the kubelet's traffic cannot be told from any other
process on the node) never reaches the write routes.

Cloudflare cannot end one user's session for one application, so removing a
guest takes `PUT /guests` followed by `POST /revoke`, which asks Cloudflare to
end every guest's session. That was the owner's choice (the narrow token). The
schema says "revokes all tokens issued for an application"; whether that also
ends the sessions of people signed in with the one-time PIN is not documented,
so rollout step 12 must prove it (see "For the manifests change").

The notification routes fix the shape of the later email feature (design
section F): the service will write the text and the link, and the app only
names what to announce. Resend is not called yet and its key file
(`RESEND_KEY_FILE`) is not read.

## Rules

Requests are refused before anything else when:

- **Host discipline.** The `Host` header is not one of `ALLOWED_HOSTS` (404; only
  `/healthz` is exempt, for kubelet probes). Only the five paths above exist
  (404), with the listed methods (405). A request with an `Origin` or
  `Sec-Fetch-Site` header is a browser's, not the app's (403). A body must be
  `application/json` (415), at most 16 KB (413) and valid (400).

`GET /guests` and `PUT /guests` also refuse (409, with an `alert` log line, and
nothing is written) unless the policy is the one Terraform made:

- it is reusable, used by exactly one application, and named `ACCESS_POLICY_NAME`
  (default `reports-share guests`), so a wrong ID in the settings cannot make
  the service edit another policy;
- its decision is `allow`, and it has no `exclude` or `require` rules;
- every include rule is exactly `{email: {email: "<address>"}}` (not a domain, a
  group, "everyone" or a rule with an extra key). Someone changed it by hand.

Before each write, the service also reads the application and requires that its
policies include `ACCESS_POLICY_ID` (409 and an alert otherwise).

Addresses read from the policy are lower cased and listed once, so what
`GET /guests` returns can always be sent back to `PUT /guests`.

`PUT /guests` also refuses:

- an empty list (409 `last_guest`): the service never writes an empty list.
- an address that is not lower case, is over 254 characters, or is not plain
  ASCII `name@domain.tld` (letters, digits and `._%+-` before the `@`; dotted
  labels of letters, digits and inner dashes after it; no dot at the start or
  end of the name and no `..`), which leaves out wildcards, spaces, quotes, IP
  literals, look-alike and invisible characters; or is listed twice (400).
- more than 25 guests (400).
- a write while another one runs (409 `write_in_progress`; also for
  `POST /revoke`).
- more than 20 writes in a sliding hour (429 with `retry-after`). `POST /revoke`
  counts as a write. Refused requests and a list equal to the current one do not
  use up the limit (the second writes nothing).

The write reads the policy, replaces only `include` and sends every other field
back as it was read. The fields that the update does not accept (`id`,
`created_at`, `updated_at`, `account_id`, `app_count`, `reusable`) are left out.
A `null` is sent back as `null` for `session_duration` (the only nullable field
of the update) and left out for any other field. Fields this code does not know
are sent back untouched. After the write, the policy Cloudflare returns must
hold exactly the requested emails, or the service logs an alert and answers 502.

**Owner check after the first live write:** `just dns plan` must show no change
to the policy. If it does, the write-back changed a field; stop and look.

Reads are answered from memory: `GET /guests` for 30 seconds (a write clears
it) and `GET /last-login` for 5 minutes per address (100 addresses at most), so
a caller that polls cannot use up the Cloudflare API quota.

The write count and the lock are in memory: the Deployment will run one replica,
and a restart starts the hour from zero.

## Cloudflare calls and token permissions

Checked on 2026-11-07 against the published API schema
(`github.com/cloudflare/api-schemas`, `openapi.json`). The dashboard calls
"Write" "Edit". The token needs the two groups in bold.

| Need                  | Call                                                 | Token group                                   |
| --------------------- | ---------------------------------------------------- | --------------------------------------------- |
| Read the list         | `GET /accounts/{a}/access/policies/{policy}`         | Access: Apps and Policies Read or **Write**   |
| Change the list       | `PUT` on the same path                               | Access: Apps and Policies **Write**           |
| End sessions          | `POST /accounts/{a}/access/apps/{app}/revoke_tokens` | Access: Apps and Policies Revoke or **Write** |
| Check the application | `GET /accounts/{a}/access/apps/{app}`                | Access: Apps and Policies Read or **Write**   |
| Last sign-in          | `GET /accounts/{a}/access/logs/access_requests`      | Access: **Audit Logs Read**                   |

The log call is sent `email`, `email_exact=true`, `emailOp=eq`, `direction=desc` and `limit=100`.
The schema has an `app_uidOp` operator but no `app_uid` parameter, so the
application is matched on each returned entry instead. A guest whose last 100
events are all for other applications or denials shows `null`.

## Configuration

| Variable                | Default                                          | Meaning                                                              |
| ----------------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | required                                         | Account ID (Terraform output `reports_share_access_account_id`)      |
| `ACCESS_POLICY_ID`      | required                                         | The guest policy (Terraform output `reports_share_access_policy_id`) |
| `ACCESS_POLICY_NAME`    | `reports-share guests`                           | The name the guest policy must have                                  |
| `ACCESS_APP_ID`         | required                                         | The Access application (output `reports_share_access_app_id`)        |
| `CLOUDFLARE_TOKEN_FILE` | `/run/credentials/cloudflare-token`              | File that holds the token (trimmed); read again on every request     |
| `RESEND_KEY_FILE`       | unset                                            | Resend sending key. Not read yet                                     |
| `ALLOWED_HOSTS`         | `share-admin.share-admin.svc.cluster.local:8080` | Comma list of accepted `Host` values (exact, case-insensitive)       |
| `PORT`                  | `8080`                                           | Listens on `0.0.0.0`                                                 |
| `HEALTH_PORT`           | `8081`                                           | `/healthz` only; must differ from `PORT`                             |

The three IDs are checked at start (8 to 64 letters, digits and dashes) and the
service stops on a bad value. The Cloudflare base URL is a constant in
`src/index.ts`, so the token cannot go anywhere else, and redirects are refused.

The token is read again on every request, so a rotated Secret takes effect
without a restart. It never appears in a log line or a response body: Cloudflare
errors are logged by status and numeric code only, never their text.

## Logs

One JSON line on stdout per entry (Loki scrapes it), each with `time` and
`event`:

- `audit`: one per write that reached Cloudflare. `action` (`guests.put` or
  `revoke`), `ok` (`true`, `false`, or `"unknown"` when a timeout came after the request
  was sent and Cloudflare may have applied it), and for `guests.put` the `added` and `removed` emails, the
  new `count` and `verified` (the stored policy matched).
- `alert`: the policy is not the plain guest list, the application does not
  use it, Cloudflare stored something else, or it rejected the token (401/403).
- `refused`: the last-guest and rate-limit refusals.
- `error`: the token file is unusable or Cloudflare failed (`upstreamStatus`,
  `codes`).
- `listening`: at start.

## For the manifests change

Notes for the later Kubernetes PR:

- The Service must expose port 8080 itself (the app calls the Service, and a
  pod-only port would be unreachable), and `ALLOWED_HOSTS` must match the Host
  the app sends exactly, port included (the default is the Service's cluster
  DNS name with `:8080`). `SHARE_ADMIN_URL` in the app must use that name.
- Probes use `HEALTH_PORT` (8081), not 8080.
- The Deployment strategy must be `Recreate`, so two replicas never run at once
  (the lock and the write count are per process).
- The three IDs come from `cluster-secrets` (`SECRET_SHARE_ACCESS_ACCOUNT_ID`,
  `SECRET_SHARE_ACCESS_POLICY_ID`, `SECRET_SHARE_ACCESS_APP_ID`); the token is a
  SOPS Secret mounted at `/run/credentials`.
- Rollout step 12 (end-to-end, with two test guests, A and B, signed in with a
  one-time PIN): remove A with `PUT /guests` and `POST /revoke`. Then check that
  A's next request to `share.<zone>` is refused, that B's existing session was
  ended too (B signs in again; that is the documented cost) and that B can sign
  in again. Finally run `just dns plan`: no change to the policy.

## Verify

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
docker build --platform linux/amd64 -t reports-share-admin:test .
bash scripts/smoke-share-admin.sh reports-share-admin:test   # with no argument it builds an amd64 image first
```

The tests run against a fake Cloudflare (an in-process HTTP server) and cover
every refusal, that the policy's other fields come back unchanged, the hourly
limit, the token being read again after rotation and the token never appearing
in a log line or an answer.

The image is Bun's distroless variant, pinned by digest like the other
integration images (the base image tag and digest change together in
`Dockerfile`): no shell, user `1000:1000`. The smoke test runs it with a
read-only root, no capabilities, a tmpfs `/tmp`, a dummy token file and no
network, and fails if the dummy token appears in the output.

The workflow `.github/workflows/reports-share-admin.yaml` checks pull requests
and publishes only a checked main revision (or an explicit main dispatch) to
`ghcr.io/<owner>/<homelab-repo>/reports-share-admin:sha-<sha>`. Deployments pin
the resulting digest.
