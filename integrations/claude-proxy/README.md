# Claude proxy

A small proxy that adds the Anthropic API key to Claude API requests. It lets a
personal platform app run a Claude Agent SDK agent although platform apps hold
no Secrets and have no internet access. The agent's CLI sets
`ANTHROPIC_BASE_URL` to this proxy. Only the proxy holds the key, and only the
proxy reaches `api.anthropic.com`.

This is infrastructure outside the personal app platform, like the Deal Watch
integrations worker. The Kubernetes manifests are in
`kubernetes/apps/claude-proxy/`; its README has the activation steps.

## Routes

| Route                              | Result                                                     |
| ---------------------------------- | ---------------------------------------------------------- |
| `GET /healthz`                     | 200 when the key file is readable and not empty, else 503  |
| `GET /usage`                       | `{day, spentUsd, capUsd, requests}` for the current UTC day |
| `POST /v1/messages`                | Checked, then forwarded and counted                        |
| `POST /v1/messages/count_tokens`   | Forwarded; free, so not counted and not blocked by the cap |
| anything else                      | 404 in the Anthropic error shape                           |

`requests` is the number of `/v1/messages` requests that reached Anthropic
today, failed ones included.

## What happens to a request

1. A `/v1/messages` request is refused with 403 (`permission_error`) when
   today's estimated spend has reached `DAILY_CAP_USD`. The proxy does not use
   429 for this, because the CLI retries 429.
2. The body must be at most 32 MB. A `/v1/messages` body must be JSON with a
   `model` in `ALLOWED_MODELS`, else 400 (`invalid_request_error`).
3. Without a usable key file the proxy answers 503 and forwards nothing.
4. When `MAX_CONCURRENT` requests are already open upstream, the proxy answers
   429 (`rate_limit_error`) with `retry-after: 5`.
5. The request goes to the fixed upstream `https://api.anthropic.com` (a
   constant in `src/index.ts`) on the same path. The query string is dropped
   and redirects are refused, so the key is never sent to another host.

Only these request headers are copied: `content-type`, `accept`,
`anthropic-version`, `anthropic-beta` and `user-agent`. All others are dropped,
including `x-api-key`, `authorization`, `cookie`, `host` and hop-by-hop
headers. The proxy then sets `x-api-key` from the key file.

The response status and body are passed back unchanged, as a stream. Only these
response headers are copied: `content-type`, `request-id`, `retry-after` and
`x-should-retry`. `set-cookie` is never copied.

The key is read again on every request, so a rotated Secret takes effect
without a restart. It never appears in a log line or a response body.

## Cost estimate and daily cap

While the response streams back, the proxy reads its token usage: from
`message_start` and `message_delta` events for a stream (the `message_delta`
values are running totals), or from `usage` in a JSON response. It counts
input, output, cache writes (5-minute and 1-hour), cache reads and web search
requests, and prices them with the table in `src/prices.ts`.

The prices are **estimates**. The Anthropic Console is the real record of
spend. The table does not model fast mode, batch discounts or data-residency
prices. The proxy refuses to start when `ALLOWED_MODELS` names a model that has
no price in the table.

Limits of the cap:

- A request that is already in flight may push the day's total past the cap.
  That is accepted.
- If the caller disconnects, the usage seen so far is still charged.
- The day's total is kept in `SPEND_FILE` on the pod's `/tmp` volume. It
  survives a container restart, but a new pod (rollout, eviction, node drain)
  starts the day from zero. Set a spend limit in the Anthropic Console as the
  hard backstop.

## Configuration

| Variable                 | Default                             | Meaning                                  |
| ------------------------ | ----------------------------------- | ---------------------------------------- |
| `ANTHROPIC_API_KEY_FILE` | `/run/credentials/anthropic-api-key` | File that holds the key (trimmed)        |
| `ALLOWED_MODELS`         | `claude-opus-5-5,claude-haiku-5-5`  | Comma list; each needs a price           |
| `DAILY_CAP_USD`          | `20`                                | Estimated USD per UTC day                |
| `MAX_CONCURRENT`         | `4`                                 | Open upstream requests                   |
| `SPEND_FILE`             | `/tmp/claude-proxy-spend.json`      | `{day, spentUsd, requests}`; a corrupt file is logged and ignored |
| `PORT`                   | `3000`                              | Listens on `0.0.0.0`                     |

The server's idle timeout is 75 seconds for idle connections. It is turned off
for each forwarded request, because a long non-streaming request sends nothing
until it is done.

## Logs

One JSON line per forwarded request: `time`, `path`, `model`, `status`, the
token counts, `costUsd`, `dayTotalUsd` and the upstream `requestId`. Refused
requests get a short `refused` line with the reason. Prompts, response text and
the key are never logged.

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
