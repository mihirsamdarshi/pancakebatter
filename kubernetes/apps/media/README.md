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

Set the user once per app with the script next to this file. Run it from the
repo root, on its own line in a terminal (not pasted together with other
lines):

```sh
kubernetes/apps/media/set-login.sh sonarr     # or radarr, prowlarr
```

It asks for a username, the password twice and a confirmation, then prints
`Done: sign in to <app> as '<user>'`. Sign in on the app's hostname. Running it
again replaces the login, so it is also how you fix a wrong username or a lost
password. It needs `kubectl` and `jq`, and always uses the repo's `kubeconfig`.
Nothing secret is echoed or put on a command line: the API key is read inside
the pod and the password travels over stdin.
