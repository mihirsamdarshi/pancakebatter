#!/usr/bin/env bash
# Runs the image as the cluster does: uid 1000, read-only root, no
# capabilities, a small tmpfs /tmp and a read-only credentials mount. The key
# is a dummy and the container has no network, so nothing reaches Anthropic.
#
#   smoke-proxy.sh [IMAGE]   test IMAGE, or build an amd64 image first
set -euo pipefail
proxy_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${1:-}"
if [[ -z "${image}" ]]; then
    image="claude-proxy:smoke"
    docker build --platform linux/amd64 -t "${image}" "${proxy_root}"
fi
key="test-proxy-key-not-real"
credentials="$(mktemp -d)"
trap 'rm -rf "${credentials}"' EXIT
printf '%s\n' "${key}" >"${credentials}/anthropic-api-key"
chmod 0755 "${credentials}"
chmod 0644 "${credentials}/anthropic-api-key"

status=0
output="$(docker run --platform linux/amd64 --rm --network none --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges --memory 256m \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --mount "type=bind,source=${credentials},target=/run/credentials,readonly" \
  --entrypoint bun "${image}" -e '
    import {readFileSync} from "node:fs";
    if(process.getuid()!==1000)throw new Error("Wrong uid");
    const check=async(what,response,status)=>{
      const body=await response.text();
      if(response.status!==status)throw new Error(`${what}: expected ${status}, got ${response.status}`);
      console.log(JSON.stringify({smoke:what,status:response.status,body}));
    };
    const message=(model)=>({method:"POST",headers:{"content-type":"application/json","x-api-key":"caller"},
      body:JSON.stringify({model,max_tokens:1,messages:[{role:"user",content:"hi"}]})});
    // The real entrypoint, listening on 3000.
    await import("./src/index.ts");
    const proxy="http://127.0.0.1:3000";
    await check("healthz",await fetch(`${proxy}/healthz`),200);
    await check("/v1/models is not proxied",await fetch(`${proxy}/v1/models`),404);
    await check("model allowlist",await fetch(`${proxy}/v1/messages`,message("claude-fable-5-1")),400);
    await check("no network: upstream unreachable",await fetch(`${proxy}/v1/messages`,message("claude-haiku-5-5")),502);
    await check("usage",await fetch(`${proxy}/usage`),200);
    // A charged request against a loopback mock, to show the spend file is
    // written to /tmp on the read-only root.
    const {configFromEnv,createHandler}=await import("./src/proxy.ts");
    const mock=Bun.serve({port:3001,hostname:"127.0.0.1",fetch(){
      return Response.json({type:"message",usage:{input_tokens:1000,output_tokens:100}});}});
    const handler=createHandler("http://127.0.0.1:3001",configFromEnv(process.env));
    const charged=await handler.fetch(new Request("http://proxy/v1/messages",message("claude-haiku-5-5")));
    await check("charged request (mock upstream)",charged,200);
    const spend=JSON.parse(readFileSync("/tmp/claude-proxy-spend.json","utf8"));
    if(spend.requests!==1||!(spend.spentUsd>0))throw new Error("spend file not written");
    await mock.stop(true);
    process.exit(0);
  ' 2>&1)" || status=$?
printf '%s\n' "${output}"
if grep -qF "${key}" <<<"${output}"; then
    echo "smoke: the key appeared in the container output" >&2
    exit 1
fi
if ((status != 0)); then
    echo "smoke: failed (exit ${status})" >&2
    exit "${status}"
fi
echo "smoke: ok"
