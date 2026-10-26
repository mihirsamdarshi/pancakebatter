# media

Jellyfin, the \*arrs (Prowlarr, Sonarr, Radarr), Seerr and Recyclarr. All of
them are on `envoy-internal` only, except the family routes that Jellyfin (and
later Seerr) add on `envoy-family`. Sonarr and Radarr mount the TrueNAS Media
share read-write over NFS as `apps` (568); Jellyfin mounts it read-only.

## First login for Sonarr, Radarr and Prowlarr

Each app starts with forms login required and an API key from its SOPS secret,
but no user, and the login page cannot create one. Until a user exists the UI
is locked; the API key still works, so Recyclarr and Prowlarr can already talk
to Sonarr and Radarr.

Set the user once per app through the API. Run this in bash from the repo root
with mise active (it sets `KUBECONFIG` and the SOPS variables; without it,
kubectl talks to whatever context is the default). Nothing secret is echoed or
put on a command line:

```sh
app=sonarr port=8989 api=v3   # radarr: 7878 v3; prowlarr: 9696 v1
key=$(sops -d --extract "[\"stringData\"][\"$(tr a-z A-Z <<<"$app")__AUTH__APIKEY\"]" \
    kubernetes/apps/media/$app/app/secret.sops.yaml)
read -rp 'Username: ' U; read -rsp 'Password: ' P; echo; export U P
kubectl -n media port-forward svc/$app $port:$port >/dev/null &
for i in 1 2 3 4 5 6 7 8 9 10; do curl -fs -o /dev/null localhost:$port/ping && break; sleep 1; done
hdr() { printf 'header = "X-Api-Key: %s"\n' "$key"; }   # read by curl -K, not argv
curl -fsS -K <(hdr) localhost:$port/api/$api/config/host \
    | jq '.username = env.U | .password = env.P | .passwordConfirmation = env.P' \
    | curl -fsS -o /dev/null -w '%{http_code}\n' -X PUT -K <(hdr) \
        -H 'Content-Type: application/json' -d @- localhost:$port/api/$api/config/host/1
kill %1; unset key U P
```

`202` means the user is set; sign in on the app's hostname. To change the
password later, use Settings > General in the app.
