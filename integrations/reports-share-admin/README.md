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
| `GET /healthz`           | 200 when the token file is readable and not empty, else 503. Any Host. Does not call Cloudflare              |
| `GET /guests`            | `{emails}`: the emails in the policy's include list                                                          |
| `PUT /guests`            | Body `{emails: [...]}`. Replaces the include list with one single-email rule each. `{emails, changed}`       |
| `POST /revoke`           | Ends every session of the application: all guests sign in again. `{revoked: true}`                           |
| `GET /last-login?email=` | `{email, lastLogin}`: time of the newest allowed Access request of this application by that email, or `null` |
| `POST /notify/invite`    | Body `{email}`. Checked, then 501: notification email is not switched on yet                                 |
| `POST /notify/published` | Body `{collection, titles}` (1 to 10 titles, 120 characters each). Checked, then 501                         |

Cloudflare cannot end one user's session for one application, so removing a
guest takes `PUT /guests` followed by `POST /revoke`, which signs out every
guest. That was the owner's choice (the narrow token).

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
nothing is written) when:

- the policy's decision is not `allow`, or
- any include rule is not exactly `{email: {email: "<address>"}}` (a domain, a
  group, "everyone", an extra key). Someone changed the policy by hand.

`PUT /guests` also refuses:

- an empty list (409 `last_guest`): the service never writes an empty list.
- an address that is not lower case, is over 254 characters, does not have
  exactly one `@`, has a wildcard `*` or a space, or is listed twice (400).
- more than 25 guests (400).
- a write while another one runs (409 `write_in_progress`; also for
  `POST /revoke`).
- more than 20 writes in a sliding hour (429 with `retry-after`). `POST /revoke`
  counts as a write. Refused requests and a list equal to the current one do not
  use up the limit (the second writes nothing).

The write reads the policy, replaces only `include` and sends every other field
back as it was read. The fields that the update does not accept (`id`,
`created_at`, `updated_at`, `account_id`, `app_count`, `reusable`) are left out,
and a field that is `null` is left out, which Cloudflare treats like unset.
Fields this code does not know are sent back untouched.

The write count and the lock are in memory: the Deployment will run one replica,
and a restart starts the hour from zero.

## Cloudflare calls and token permissions

Checked on 2026-11-07 against the published API schema
(`github.com/cloudflare/api-schemas`, `openapi.json`). The dashboard calls
"Write" "Edit". The token needs the two groups in bold.

| Need            | Call                                                 | Token group                                   |
| --------------- | ---------------------------------------------------- | --------------------------------------------- |
| Read the list   | `GET /accounts/{a}/access/policies/{policy}`         | Access: Apps and Policies Read or **Write**   |
| Change the list | `PUT` on the same path                               | Access: Apps and Policies **Write**           |
| End sessions    | `POST /accounts/{a}/access/apps/{app}/revoke_tokens` | Access: Apps and Policies Revoke or **Write** |
| Last sign-in    | `GET /accounts/{a}/access/logs/access_requests`      | Access: **Audit Logs Read**                   |

The log call is sent `email`, `emailOp=eq`, `direction=desc` and `limit=100`.
The schema has an `app_uidOp` operator but no `app_uid` parameter, so the
application is matched on each returned entry instead. A guest whose last 100
events are all for other applications or denials shows `null`.

## Configuration

| Variable                | Default                                          | Meaning                                                              |
| ----------------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | required                                         | Account ID (in the dashboard URL)                                    |
| `ACCESS_POLICY_ID`      | required                                         | The guest policy (Terraform output `reports_share_access_policy_id`) |
| `ACCESS_APP_ID`         | required                                         | The Access application (output `reports_share_access_app_id`)        |
| `CLOUDFLARE_TOKEN_FILE` | `/run/credentials/cloudflare-token`              | File that holds the token (trimmed); read again on every request     |
| `RESEND_KEY_FILE`       | unset                                            | Resend sending key. Not read yet                                     |
| `ALLOWED_HOSTS`         | `share-admin.share-admin.svc.cluster.local:8080` | Comma list of accepted `Host` values (exact, case-insensitive)       |
| `PORT`                  | `8080`                                           | Listens on `0.0.0.0`                                                 |

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
  `revoke`), `ok`, and for `guests.put` the `added` and `removed` emails and the
  new `count`.
- `alert`: the policy is not the plain allow-list (see above).
- `refused`: the last-guest and rate-limit refusals.
- `error`: the token file is unusable or Cloudflare failed (`upstreamStatus`,
  `codes`).
- `listening`: at start.

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
