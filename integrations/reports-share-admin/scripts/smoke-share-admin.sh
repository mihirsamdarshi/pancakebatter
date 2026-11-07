#!/usr/bin/env bash
# Runs the image as the cluster does: uid 1000, read-only root, no
# capabilities, a small tmpfs /tmp and a read-only credentials mount. The token
# is a dummy and the container has no network, so nothing reaches Cloudflare.
# The image has no shell, so the check runs as a Bun script (--entrypoint bun).
#
#   smoke-share-admin.sh [IMAGE]   test IMAGE, or build an amd64 image first
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${1:-}"
if [[ -z "${image}" ]]; then
    image="reports-share-admin:smoke"
    docker build --platform linux/amd64 -t "${image}" "${root}"
fi
token="test-cloudflare-token-not-real"
credentials="$(mktemp -d)"
trap 'rm -rf "${credentials}"' EXIT
printf '%s\n' "${token}" >"${credentials}/cloudflare-token"
chmod 0755 "${credentials}"
chmod 0644 "${credentials}/cloudflare-token"

status=0
output="$(docker run --platform linux/amd64 --rm --network none --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges --memory 256m \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --mount "type=bind,source=${credentials},target=/run/credentials,readonly" \
  -e CLOUDFLARE_ACCOUNT_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  -e ACCESS_POLICY_ID=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  -e ACCESS_APP_ID=11111111-2222-3333-4444-555555555555 \
  --entrypoint bun "${image}" -e '
    if(process.getuid()!==1000)throw new Error("Wrong uid");
    const check=async(what,response,status)=>{
      const body=await response.text();
      if(response.status!==status)throw new Error(`${what}: expected ${status}, got ${response.status}`);
      console.log(JSON.stringify({smoke:what,status:response.status,body}));
    };
    // The real entrypoint, listening on 8080.
    await import("./src/index.ts");
    const service="http://127.0.0.1:8080";
    const host={host:"share-admin.share-admin.svc.cluster.local:8080"};
    await check("healthz on the probe port",await fetch("http://127.0.0.1:8081/healthz"),200);
    await check("probe port has no other route",await fetch("http://127.0.0.1:8081/guests"),404);
    await check("healthz is not on the service port",await fetch(`${service}/healthz`,{headers:host}),404);
    await check("wrong Host",await fetch(`${service}/guests`,{headers:{host:"other.test"}}),404);
    await check("unknown path",await fetch(`${service}/policy`,{headers:host}),404);
    await check("bad body",await fetch(`${service}/guests`,{method:"PUT",headers:{...host,"content-type":"application/json"},body:JSON.stringify({emails:["Bad"]})}),400);
    await check("no network: Cloudflare unreachable",await fetch(`${service}/guests`,{headers:host}),502);
    process.exit(0);
  ' 2>&1)" || status=$?
printf '%s\n' "${output}"
if grep -qF "${token}" <<<"${output}"; then
    echo "smoke: the token appeared in the container output" >&2
    exit 1
fi
if ((status != 0)); then
    echo "smoke: failed (exit ${status})" >&2
    exit "${status}"
fi
echo "smoke: ok"
