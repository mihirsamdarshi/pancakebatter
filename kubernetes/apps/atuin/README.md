# atuin

Two [Atuin](https://docs.atuin.sh/) sync servers. Atuin keeps shell history,
and the AI sessions it captures, in an encrypted store on each machine and
syncs that store through a server.

| Server        | For                                           | Address                            | Node     |
| ------------- | --------------------------------------------- | ---------------------------------- | -------- |
| `atuin-linux` | The Linux machines (workspace VM, PC desktop) | `https://atuin-linux.local.<zone>` | talos-02 |
| `atuin-mac`   | The Macs                                      | `https://atuin-mac.local.<zone>`   | talos-03 |

Each is its own namespace, Flux Kustomization, HelmRelease, volume, backup,
route and network policy. They share nothing but the cluster, the internal
gateway and the backup share (each has its own restic repository there). Both
are on `envoy-internal` only: no public, family or Tailscale route.

## Never one server with two accounts

The split keeps work and personal history apart. `atuin login` re-encrypts
everything already on a machine with the key you give it, and the next sync
uploads all of it to that account. Every other machine of the group then
downloads it, and it cannot be picked back out. With one server and two
accounts, every machine would use the same address, so one wrong paste from
1Password would mix the groups. With two servers a wrong login needs the other
server's address as well as its name, password and key. Do not merge them, and
do not add a second account to either.

## Registration

Registration is open in the first change (`ATUIN_OPEN_REGISTRATION: "true"` in
each `app/helmrelease.yaml`), and anyone who can reach the server can register.
To close it:

1. On one machine of the group, in your own terminal, point Atuin at the
   group's server (`sync_address` in `~/.config/atuin/config.toml`) and run
   `atuin register`. Save the name, password and key (`atuin key`) in the
   group's 1Password item (below).
2. Do the same for the other server, from a machine of the other group.
3. A follow-up change sets `ATUIN_OPEN_REGISTRATION` to `"false"` on both.
   After it is merged, a second `atuin register` must be refused.

Other machines of the group join with `atuin login`, never `atuin register`.

## Keys

Each group has one 1Password item in the owner's vault, "Atuin Linux group"
and "Atuin Mac group": user name, password and encryption key. Paste them at
`atuin login` in your own terminal. The key never goes into Git, SOPS, Beads or
a Claude session. The server holds only ciphertext: without the key its copy
cannot be read, but every member machine keeps its own data and can re-key and
push it again (`atuin store push`).

## Storage and backup

Each server keeps `server.toml` and its SQLite database (`atuin.db`, WAL mode)
on a 5 GiB `local-retain` volume, so it runs only on its node. The size is
nominal; watch growth once sessions sync. The `volsync` and `sqlite-export`
components back it up each night to the TrueNAS share (times in UTC):

| App         | Namespace   | Export | Backup |
| ----------- | ----------- | ------ | ------ |
| atuin-linux | atuin-linux | 13:35  | 13:45  |
| atuin-mac   | atuin-mac   | 13:50  | 14:00  |

Both run as the image's user, 1000:1000 (`APP_UID`, `APP_GID`). After the
first deploy, run the first export and a second backup by hand, as step 4 of
"Add an app" in `kubernetes/components/volsync/README.md` describes; restores
follow the same README.

## Upkeep

The image is pinned by tag and digest. Keep the clients and the servers on the
same major version, and close in minor. Atuin releases often, so update on your
schedule, and restart the Atuin daemon on each machine after a client update.
