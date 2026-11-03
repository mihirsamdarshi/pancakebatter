#!/usr/bin/env bash
# Offline smoke test: non-root, read-only root, tmpfs writable paths, no network.
# Makes no retailer request. Checks /healthz and a bad /observe body.
set -euo pipefail
image="${1:?pass the locally built browser image}"
name="deal-watch-browser-smoke-$$"
cleanup() { docker rm -f "${name}" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "${name}" --platform linux/amd64 --network none --read-only --user 1001:1001 \
  --cap-drop ALL --security-opt no-new-privileges --memory 1536m --shm-size 256m \
  --tmpfs /tmp:rw,nosuid,size=128m \
  --tmpfs /home/pwuser:rw,nosuid,size=256m,uid=1001,gid=1001 \
  "${image}" >/dev/null
# --network none: reach the server from inside the container's own namespace.
call() { docker exec "${name}" node -e '
  const [method, path, body] = process.argv.slice(1);
  fetch("http://127.0.0.1:3000" + path, { method, body: body || undefined, headers: { "content-type": "application/json" } })
    .then(async (r) => { console.log(r.status); }).catch(() => console.log("000"));
' "$@"; }
health=000
for _ in $(seq 1 60); do
  health="$(call GET /healthz 2>/dev/null || echo 000)"
  [ "${health}" = 200 ] && break
  sleep 2
done
if [ "${health}" != 200 ]; then
  echo "healthz expected 200, got ${health}" >&2
  docker logs "${name}" >&2 || true
  exit 1
fi
ver="$(docker exec "${name}" node -e 'fetch("http://127.0.0.1:3000/healthz").then(r=>r.json()).then(j=>console.log(j.chromeVersion))')"
case "${ver}" in [0-9]*) echo "chrome ${ver}";; *) echo "no chromeVersion in /healthz" >&2; exit 1;; esac
bad="$(call POST /observe '{"retailer":"nope","productId":"x"}')"
[ "${bad}" = 400 ] || { echo "bad body expected 400, got ${bad}" >&2; exit 1; }
uid="$(docker exec "${name}" id -u)"
[ "${uid}" = 1001 ] || { echo "wrong uid ${uid}" >&2; exit 1; }
echo "browser smoke OK"
