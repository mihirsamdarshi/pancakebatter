# media

Jellyfin, the \*arrs (Prowlarr, Sonarr, Radarr), Seerr and Profilarr. All of
them are on `envoy-internal` only, except the family routes that Jellyfin (and
later Seerr) add on `envoy-family`. Sonarr and Radarr mount the TrueNAS Media
share read-write over NFS as `apps` (568); Jellyfin mounts it read-only.

## First login for Sonarr, Radarr and Prowlarr

Each app starts with forms login required and an API key from its SOPS secret,
but no user, and the login page cannot create one. Until a user exists the UI
is locked; the API key still works, so Profilarr and Prowlarr can already talk
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

## Profilarr

Profilarr (`profilarr.<zone>`, internal only) pushes quality profiles, custom
formats, naming, quality sizes and delay profiles from a database to Sonarr
and Radarr. It replaces Recyclarr. Its `/config` holds copies of the Sonarr and
Radarr API keys, so treat it as secret-bearing.

1. First login: open the site right after the pod is ready. With `AUTH=on` the
   first visitor is sent to `/auth/setup` and creates the admin account.
2. Link the TRaSH database: `https://github.com/Dictionarry-Hub/trash-pcd`
   (a Dictionarry port of the TRaSH Guides; it can lag the guides).
3. Add the apps with their in-cluster URLs and API keys (the keys are in the
   `sonarr-secret` and `radarr-secret` secrets, `SONARR__AUTH__APIKEY` and
   `RADARR__AUTH__APIKEY`):
   `http://sonarr.media.svc.cluster.local:8989` and
   `http://radarr.media.svc.cluster.local:7878`.
4. Sync Radarr first and check the result in Radarr before syncing Sonarr. How
   a first sync treats existing profiles with the same names is undocumented.
5. A sync creates or updates profiles; it does not assign them to existing
   series or movies. It also changes naming, quality sizes and delay profiles.
   Local score tweaks live in Profilarr's database, not in git.

## Trawl (challenge solver for Prowlarr)

Trawl is a FlareSolverr-compatible service for indexers behind Cloudflare
challenges. It is cluster-internal only (ClusterIP on 8191, no route) and a
network policy admits Prowlarr alone. In Prowlarr, Settings > Indexers, add an
Indexer Proxy of type FlareSolverr with host
`http://trawl.media.svc.cluster.local:8191` and a tag, then give that tag only
to the indexers that need it.
Trawl's egress allows only TCP 80 and 443 to the internet, so an indexer on
another port will not work.

## Backups

Every app here except Trawl (no state) has its config volume backed up each
night by the `volsync` component: restic to the TrueNAS share
`Backups/volsync`, 7 daily snapshots plus the component's weekly and monthly
ones. Apps with SQLite databases also use `sqlite-export`, which writes a
consistent copy of each database ten minutes before the backup. Only the config
volumes are backed up, not the TrueNAS Media share they mount. The restore and
first-backup steps are in `kubernetes/components/volsync/README.md`.

Each app has its own slot, 15 minutes apart, so the movers never overlap. Times
are UTC (10:00 is 03:00 Pacific in summer). Tdarr is first on purpose: its
transcode window opens at 04:00 Pacific (11:00 UTC or later) and its database
is busiest then.

| App           | Namespace     | Export | Backup | Exported databases                  |
| ------------- | ------------- | ------ | ------ | ----------------------------------- |
| jellyfin      | media         | 09:50  | 10:00  | `data/jellyfin.db`                  |
| quilt-planner | quilt-planner | 10:05  | 10:15  | `quilt.db`                          |
| tdarr         | media         | 10:20  | 10:30  | `server/Tdarr/DB2/SQL/database.db`  |
| sonarr        | media         | 10:35  | 10:45  | `sonarr.db`, `logs.db`              |
| radarr        | media         | 10:50  | 11:00  | `radarr.db`, `logs.db`              |
| prowlarr      | media         | 11:05  | 11:15  | `prowlarr.db`, `logs.db`            |
| seerr         | media         | 11:20  | 11:30  | `db/db.sqlite3`                     |
| profilarr     | media         | 11:35  | 11:45  | `data/profilarr.db`                 |
| qbittorrent   | downloads     | 11:50  | 12:00  | `qBittorrent/torrents.db`           |

The next free slot is export 12:05, backup 12:15. The volume claim for each app
is named after its release because the chart creates only one PVC per app: if a
second PVC is ever added, the name changes and `VOLSYNC_CLAIM` must follow.
