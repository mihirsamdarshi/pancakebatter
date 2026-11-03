# Claude proxy

A small proxy that adds the Anthropic API key to Claude API requests. It lets a
personal platform app run a Claude Agent SDK agent although platform apps hold
no Secrets and have no internet access. The agent's CLI sets
`ANTHROPIC_BASE_URL` to this proxy. Only the proxy holds the key, and only the
proxy reaches `api.anthropic.com`.

This is infrastructure outside the personal app platform, like the Deal Watch
integrations worker. The Kubernetes manifests are in
`kubernetes/apps/personal-apps/claude-proxy/`; its README has the activation steps.

## Routes

| Route                            | Result                                                          |
| -------------------------------- | --------------------------------------------------------------- |
| `GET /healthz`                   | 200 when the key file is readable and not empty, else 503       |
| `GET /usage`                     | `{day, spentUsd, reservedUsd, capUsd, requests}` for the UTC day |
| `POST /v1/messages`              | Checked, then forwarded and counted                             |
| `POST /v1/messages/count_tokens` | Forwarded; free, so not counted and not blocked by the cap      |
| anything else                    | 404 in the Anthropic error shape                                |

`requests` is the number of `/v1/messages` requests that reached Anthropic
today, failed ones included. `reservedUsd` is held by requests in progress
(see below).

## What happens to a request

1. **A concurrency slot.** When `MAX_CONCURRENT` requests are already in
   progress, the proxy answers 429 (`rate_limit_error`) with `retry-after: 5`.
   The slot is taken before the body is read, so slow or large uploads count
   too.
2. **The body.** It must be at most 16 MB (413) and arrive within 60 seconds
   (408). A declared `content-length` over the limit is refused before
   anything is read.
3. **Checks on `/v1/messages`.** The body must be a JSON object with a `model`
   in `ALLOWED_MODELS` (400). Request fields that change the price are refused
   (400): `speed`, `fallbacks`, `mcp_servers`, an `inference_geo` other than
   `"global"`, and any tool that has its own `model`, an `advisor_*` type or
   the `mcp_toolset` type. `anthropic-beta` headers are not restricted: the
   CLI sends several, and the fields above are what the costly betas need.
4. **A key.** Without a usable key file the proxy answers 503 and forwards
   nothing.
5. **The daily cap** (see below). A request that does not fit is refused with
   403 (`permission_error`).
6. **The upstream call.** The request goes to the fixed upstream
   `https://api.anthropic.com` (a constant in `src/index.ts`) on the same path.
   The query string is dropped and redirects are refused, so the key is never
   sent to another host. The body sent is the parsed JSON, serialized again:
   with a duplicated key such as `"model"`, JSON parsers keep the last value,
   and the upstream sees only the value that was checked.

**Retries.** The Anthropic SDKs, and so the CLI, obey an `x-should-retry`
header before their own rules, which retry 408, 409, 429 and 5xx. The 400, 403,
413 and 503 refusals carry `x-should-retry: false`, because retrying cannot fix
them; without it the CLI would retry the 503. The cap uses 403 rather than 429
for the same reason, and its message never contains the text `model:`, which
the CLI reads as a refused model and answers by switching models. The 429 for
concurrency and the 408 have no such header, so the CLI retries them, after the
`retry-after` delay for the 429.

Only these request headers are copied: `content-type`, `accept`,
`anthropic-version`, `anthropic-beta` and `user-agent`. All others are dropped,
including `x-api-key`, `authorization`, `cookie`, `host` and hop-by-hop
headers. The proxy then sets `x-api-key` from the key file.

The response status and body are passed back unchanged, as a stream. Only these
response headers are copied: `content-type`, `request-id`, `retry-after` and
`x-should-retry`. `set-cookie` is never copied. Forwarded responses carry
`connection: close`, so a connection is not kept open after a long request.

The key is read again on every request, so a rotated Secret takes effect
without a restart. It never appears in a log line or a response body.

## Cost estimate and daily cap

**Reservations.** Before a `/v1/messages` request is sent, the proxy estimates
its largest likely cost: the request size in bytes divided by 3, as uncached
input tokens, plus `max_tokens` (128,000 when absent) as output tokens, at the
request model's prices. The request is admitted only if the day's spend, plus
the reservations of requests in progress, plus this estimate, is at most
`DAILY_CAP_USD`. The estimate is reserved until the request finishes, then
replaced by the real cost.

**Real cost.** While the response streams back, the proxy reads its token
usage: from `message_start` and `message_delta` events for a stream (the
`message_delta` values are running totals), or from the end of a JSON response
(only the last 256 KB is kept, never the whole body). It counts input, output,
cache writes (5-minute and 1-hour), cache reads and web search requests, and
prices them with the table in `src/prices.ts`. When the response has
`usage.iterations` (one entry per attempt), the attempts are added up.

**Fail closed.** A successful response (status below 400) without readable
usage is charged its estimate. A response that reports fast mode costs 2x, and
one that reports US-only inference 1.1x. A model without a price row, an
unknown token field or an unknown server-tool count is charged at the highest
rates in the table. Unknown field names are logged.

**Disconnects.** If the caller leaves, the upstream request still runs and is
billed, so the proxy keeps reading it to the end, discards the body and
charges the usage. This also covers a caller that leaves before the upstream
answers.

The prices are **estimates**. The Anthropic Console is the real record of
spend. The proxy refuses to start when `ALLOWED_MODELS` names a model that has
no price in the table.

Limits of the cap:

- A request can cost more than its estimate (many web searches, or text that
  packs more than one token in 3 bytes), so the day's total can still pass the
  cap. That is accepted.
- The day's total is kept in `SPEND_FILE` on the pod's `/tmp` volume. It
  survives a container restart, but a new pod (rollout, eviction, node drain)
  starts the day from zero. Reservations are kept in memory only. Set a spend
  limit in the Anthropic Console as the hard backstop.

## Configuration

| Variable                 | Default                             | Meaning                                  |
| ------------------------ | ----------------------------------- | ---------------------------------------- |
| `ANTHROPIC_API_KEY_FILE` | `/run/credentials/anthropic-api-key` | File that holds the key (trimmed)        |
| `ALLOWED_MODELS`         | `claude-opus-5-5,claude-haiku-5-5`  | Comma list; each needs a price           |
| `DAILY_CAP_USD`          | `20`                                | Estimated USD per UTC day                |
| `MAX_CONCURRENT`         | `4`                                 | Open upstream requests                   |
| `SPEND_FILE`             | `/tmp/claude-proxy-spend.json`      | `{day, spentUsd, requests}`; a corrupt file is logged and ignored |
| `PORT`                   | `3000`                              | Listens on `0.0.0.0`                     |

The server's idle timeout is 75 seconds. Once a forwarded request's body has
been read, the timeout is turned off for that request, because a long
non-streaming request sends nothing until it is done.

## Logs

One JSON line per forwarded request: `time`, `path`, `model`, `status`,
`outcome` (`complete`, `client-closed` or `upstream-error`), the token counts,
`charge` (`usage`, `estimate` or `none`), `estimatedMaxUsd`, `costUsd`,
`dayTotalUsd` and the upstream `requestId`, plus `speed`, `inferenceGeo`,
`iterations` and `unrecognised` field names when the response reports them.
Refused requests get a short `refused` line with the reason. Prompts, response
text and the key are never logged.

## Client setup

The caller sets `ANTHROPIC_BASE_URL` to
`http://claude-proxy.claude-proxy.svc.cluster.local:3000`. The Claude CLI may
also want an API key value before it starts; any placeholder works, because the
proxy drops it.

## Verify

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
docker build --platform linux/amd64 -t claude-proxy:test .
bash scripts/smoke-proxy.sh claude-proxy:test   # with no argument it builds an amd64 image first
```

The tests run against a mock upstream on a local port. The smoke test runs the
image as uid 1000 with a read-only root, no capabilities, a tmpfs `/tmp`, a
dummy key file and no network. It checks `/healthz`, that `/v1/models` is 404,
the model allowlist, a fail-closed 502 without network, and that the spend file
is written to `/tmp`. It fails if the dummy key appears in the output.

The workflow `.github/workflows/claude-proxy.yaml` checks pull requests and
publishes only a checked main revision (or an explicit main dispatch) to
`ghcr.io/<owner>/<homelab-repo>/claude-proxy:sha-<sha>`. Deployments pin the
resulting digest.
