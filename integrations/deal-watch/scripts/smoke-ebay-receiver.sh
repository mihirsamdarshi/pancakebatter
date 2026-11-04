#!/usr/bin/env bash
# Offline smoke test: non-root, read-only root, tmpfs data dir, no network. Fake token, fake
# credentials and an example.test endpoint. Makes no eBay call. The expected challenge hash is
# computed here with shasum so the check does not depend on the receiver's own code.
set -euo pipefail
image="${1:?pass the locally built receiver image}"
name="deal-watch-ebay-receiver-smoke-$$"
work="$(mktemp -d)"
cleanup() { docker rm -f "${name}" >/dev/null 2>&1 || true; rm -rf "${work}"; }
trap cleanup EXIT
token="smoke_0123456789abcdef0123456789ABCDEF-token"
endpoint="https://ebay-notify.example.test/ebay/notify"
code="smokeChallenge_42-x"
printf '%s' "${token}" >"${work}/token"
printf '{"clientId":"fake-id","clientSecret":"fake-secret"}' >"${work}/credentials.json"
chmod 644 "${work}/token" "${work}/credentials.json"
docker run -d --name "${name}" --platform linux/amd64 --network none --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges --memory 256m \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --tmpfs /data:rw,noexec,nosuid,size=16m,uid=1000,gid=1000 \
  --mount "type=bind,source=${work}/token,target=/run/secrets/token,readonly" \
  --mount "type=bind,source=${work}/credentials.json,target=/run/secrets/credentials.json,readonly" \
  -e ENDPOINT_URL="${endpoint}" -e VERIFICATION_TOKEN_FILE=/run/secrets/token \
  -e EBAY_CREDENTIALS_FILE=/run/secrets/credentials.json -e RECEIVER_INIT=allow \
  "${image}" >/dev/null
# --network none: reach the server from inside the container's own namespace.
call() { docker exec "${name}" bun -e '
  const [port, method, path, body] = process.argv.slice(1);
  fetch("http://127.0.0.1:" + port + path, { method, body: body || undefined })
    .then(async (r) => console.log(r.status + " " + (await r.text())))
    .catch(() => console.log("000"));
' "$@"; }
health=000
for _ in $(seq 1 30); do
  health="$(call 3001 GET /healthz 2>/dev/null || echo 000)"
  case "${health}" in 200*) break;; esac
  sleep 1
done
case "${health}" in 200*) ;; *) echo "healthz expected 200, got ${health}" >&2; docker logs "${name}" >&2 || true; exit 1;; esac
state="$(call 3001 GET /state)"
case "${state}" in '200 {"state":"CLEAR"'*) ;; *) echo "state expected CLEAR, got ${state}" >&2; exit 1;; esac
expected="$(printf '%s%s%s' "${code}" "${token}" "${endpoint}" | shasum -a 256 | cut -d' ' -f1)"
challenge="$(call 3000 GET "/ebay/notify?challenge_code=${code}")"
[ "${challenge}" = "200 {\"challengeResponse\":\"${expected}\"}" ] || { echo "challenge mismatch: ${challenge}" >&2; exit 1; }
for path in /state /healthz /; do
  r="$(call 3000 GET "${path}")"
  [ "${r%% *}" = 404 ] || { echo "public ${path} expected 404, got ${r}" >&2; exit 1; }
done
bad="$(call 3000 POST /ebay/notify '{}')"
[ "${bad%% *}" = 412 ] || { echo "POST without signature expected 412, got ${bad}" >&2; exit 1; }
uid="$(docker exec "${name}" id -u)"
[ "${uid}" = 1000 ] || { echo "wrong uid ${uid}" >&2; exit 1; }
if docker logs "${name}" 2>&1 | grep -qE "${token}|${code}|fake-secret"; then echo "secret or challenge code in logs" >&2; exit 1; fi
echo "ebay receiver smoke OK"
