# atuin

Two [Atuin](https://docs.atuin.sh/) sync servers. Atuin syncs shell history,
and the AI sessions it captures, between a group of machines through a
server. The server holds them encrypted with the group's key, plus the account
(name, email, password hash, session token) and each record's host, time, tag
and size in the clear.

| Server        | For                                           | Address                            | Node     |
| ------------- | --------------------------------------------- | ---------------------------------- | -------- |
| `atuin-linux` | The Linux machines (workspace VM, PC desktop) | `https://atuin-linux.local.<zone>` | talos-02 |
| `atuin-mac`   | The Macs                                      | `https://atuin-mac.local.<zone>`   | talos-03 |

Each is its own namespace, Flux Kustomization, HelmRelease, volume, backup,
route and network policy. They share only the cluster, the internal gateway
and the backup share. On that share each has its own restic repository, under
the one restic password that every app's backup uses. Both are on
`envoy-internal` only: no public or family route. The LAN, VLAN 10, cluster
pods and devices on the owner's tailnet (through the router's subnet route) can
reach them; the family gateway and family tailnets cannot.

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

Registration is closed (`ATUIN_OPEN_REGISTRATION: "false"` in each
`app/helmrelease.yaml`), so `atuin register` is refused. The owner makes each
group's one account on its server with `atuin-server admin user create`, which
works while registration is closed:

1. In your own terminal:
   `kubectl -n atuin-linux exec -it deploy/atuin-linux -- atuin-server admin user create --email <email> <name>`.
   The password is prompted twice and never appears in arguments. The exec
   inherits `ATUIN_DB_URI` and `ATUIN_CONFIG_DIR`. The command writes only to
   `/config`, opens the same SQLite file in WAL mode beside the running server,
   and runs migrations (a no-op).
2. On the first Linux machine, `atuin key` must print a key. The key file is
   made on first use: the daemon, a recorded command or `atuin search` all
   create it. If `atuin key` errors, use Atuin in a shell once, then retry. Set
   `sync_address = "https://atuin-linux.local.<zone>"` in
   `~/.config/atuin/config.toml`. Run `atuin logout` if the machine is logged
   in elsewhere. Then run `atuin login -u <name>`, give the password, and leave
   the key blank to use the existing key file. Run `atuin sync`, then save the
   name, password and `atuin key` output in "Atuin Linux group".
3. Repeat with `-n atuin-mac` (`deploy/atuin-mac`,
   `https://atuin-mac.local.<zone>`, "Atuin Mac group") from a Mac. The Mac's
   config points at the dead 2024 server, so run `atuin logout` first.
4. Check that registration is refused:
   `curl -sS -X POST https://atuin-linux.local.<zone>/register -H 'Content-Type: application/json' -d '{"username":"probe","email":"probe@example.invalid","password":"probe"}'`
   must return `this server is not open for registrations`. Repeat for
   `atuin-mac`.

Other machines of the group join with `atuin login`, never `atuin register`.

## Keys

Each group has one 1Password item in the owner's vault, made with its account:
"Atuin Linux group" and "Atuin Mac group", each with the user name, password
and encryption key. Paste them at `atuin login` in your own terminal. The key
never goes into Git, SOPS, Beads or a Claude session. Without the key the
server's copy cannot be read, but every member machine keeps its own data and
can re-key and push it again (`atuin store push`).

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
