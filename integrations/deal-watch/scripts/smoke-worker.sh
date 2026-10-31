#!/usr/bin/env bash
set -euo pipefail
image="${1:?pass the locally built worker image}"
worker_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
docker run --platform linux/amd64 --rm --network none --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges --memory 512m \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --mount "type=bind,source=${worker_root}/fixtures/example-policy.json,target=/run/watch-policy.json,readonly" \
  -e APP_BASE_URL=http://127.0.0.1:3001 -e ALLOW_LOCAL_HTTP=1 \
  -e WATCH_CONFIG_FILE=/run/watch-policy.json -e RUN_ONCE=1 \
  --entrypoint bun "${image}" -e '
    import {readPolicy} from "./src/policy.ts";
    if(process.getuid()!==1000)throw new Error("Wrong uid");
    const watches=readPolicy(process.env.WATCH_CONFIG_FILE);
    const {policyIdentity}=await import("./src/vendor/domain.ts");
    const mock=Bun.serve({port:3001,hostname:"127.0.0.1",fetch(){return Response.json({policyVersion:policyIdentity(watches),watches:watches.map(w=>({id:w.id,preferences:{paused:false,muted:false,purchased:false}}))});}});
    try{await import("./src/index.ts");}finally{await mock.stop(true);}
  '
