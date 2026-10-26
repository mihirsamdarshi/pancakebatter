# volsync component

Nightly restic backup of one app's config PVC to the TrueNAS share
`192.168.10.75:/mnt/nasty/Backups/volsync`, one repository directory per app.
The operator is in `kubernetes/apps/volsync-system`. Apps with SQLite databases
also use `kubernetes/components/sqlite-export`, which writes a consistent copy of
each database shortly before the backup.

The volsync component adds, per app: a `ReplicationSource`, the NFS PV and PVC
that the mover mounts at `/mnt/repo`, and the restic Secret (SOPS; one password
shared by all repositories, and `RESTIC_REPOSITORY=/mnt/repo/<app>`).

What it protects against: loss of a node's disk or VM, a corrupted or deleted
config. It does not protect against losing the host or TrueNAS, because the NAS
VM runs on the same machine as the cluster. Offsite copies are a later decision.

## Add an app

1. In the app's `kustomization.yaml`, add the components (adjust the number of
   `../`; leave out `sqlite-export` for an app without SQLite databases):

    ```yaml
    components:
        - ../../../../components/volsync
        - ../../../../components/sqlite-export
    ```

2. In the app's Flux `ks.yaml`, wait for the operator and set the variables:

    ```yaml
    spec:
        dependsOn:
            - name: volsync
              namespace: volsync-system
        postBuild:
            substitute:
                APP: sonarr
                VOLSYNC_CLAIM: sonarr-config
                VOLSYNC_NAMESPACE: media
                VOLSYNC_SCHEDULE: "30 10 * * *"
                SQLITE_DBS: config/sonarr.db # paths in the volume, space separated, globs allowed
                SQLITE_SCHEDULE: "20 10 * * *"
    ```

3. Back up the config volume only. Leave out anything a restart regenerates
   (caches, artwork, transcodes).

| Variable            | Component     | Meaning                                                                          |
| ------------------- | ------------- | -------------------------------------------------------------------------------- |
| `APP`               | both          | Names the ReplicationSource, Secret, PV/PVC, CronJob and repository directory    |
| `VOLSYNC_CLAIM`     | both          | The PVC to back up and to export from                                            |
| `VOLSYNC_NAMESPACE` | volsync       | The app's namespace (the PV's `claimRef`)                                        |
| `VOLSYNC_SCHEDULE`  | volsync       | Optional, UTC cron, default `0 10 * * *`                                         |
| `SQLITE_DBS`        | sqlite-export | Required: the databases, relative to the volume root                             |
| `SQLITE_SCHEDULE`   | sqlite-export | Optional, UTC cron, default `50 9 * * *` (ten minutes before the default slot)   |
| `SQLITE_UID`/`_GID` | sqlite-export | The app's user and group, default 568; a connection must be able to write `-shm` |

Mover pods run as 568:568 (the TrueNAS `apps` user), so the app's files must be
readable by 568. Direct mode needs no snapshots, but the app keeps running
during the backup: see SQLite below.

### Schedule slots

UTC: 10:00 is 03:00 Pacific in summer and 02:00 in winter. Give each app its own
slot, 15 minutes apart, so movers never overlap on a node, and run its export
ten minutes before.

| App           | Export (UTC) | Backup (UTC)          |
| ------------- | ------------ | --------------------- |
| jellyfin      | 09:50        | 10:00                 |
| quilt-planner | 10:05        | 10:15                 |
| next apps     | 10:20, 10:35 | 10:30, 10:45, 11:00 … |

## SQLite

Direct mode reads the live files. A SQLite database in WAL mode is three files
(`db`, `db-wal`, `db-shm`) that must agree; a write between restic reading the
first and the last can produce a copy that does not open cleanly, and restic
cannot tell. So every app with SQLite databases uses the `sqlite-export`
component (Jellyfin: `data/jellyfin.db`; Quilt: `quilt.db`).

Its CronJob runs shortly before the backup, on the node of the volume (the
scheduler only places a pod that uses a bound local PV on the PV's node). For
each database it writes a copy with SQLite's online backup, which is safe while
the app writes, to `.sqlite-export/<path>` on the same volume, then switches the
copy out of WAL mode, checks it (`PRAGMA integrity_check` and at least one schema
entry) and only then renames it over the previous export. A failed database keeps
yesterday's export; the other databases are still exported, and the Job fails.
The backup then captures the whole volume, exports included.

Restore databases from the exports, never from the live `db`, `db-wal` and
`db-shm`, which restic may have copied at different moments.

## Restore

There are no CSI snapshots, so a restore writes straight into the existing PVC
and the app must be stopped first. Replace `<app>`, `<ns>`, `<pvc>`, `<uid>`,
`<gid>` and `<node>`. The restic password is in 1Password and in `secret.sops.yaml`
(`sops decrypt --extract '["stringData"]["RESTIC_PASSWORD"]' kubernetes/components/volsync/secret.sops.yaml`).

1. Stop the app, and stop Flux and the nightly runs from undoing or racing it.
   Suspend the Flux Kustomization(s) that own the app and its ReplicationSource
   (for Jellyfin that is one, `jellyfin`; Quilt has `quilt-planner` and
   `quilt-planner-backup`). The export CronJob must not run either: it would
   overwrite the good copies.

    ```sh
    flux suspend kustomization <ks> -n <ns>
    flux suspend helmrelease <app> -n <ns>            # HelmRelease apps only
    kubectl -n <ns> patch replicationsource <app> --type merge -p '{"spec":{"paused":true}}'
    kubectl -n <ns> patch cronjob <app>-sqlite-export -p '{"spec":{"suspend":true}}'   # SQLite apps
    kubectl -n <ns> scale deploy/<app> --replicas=0
    kubectl -n <ns> get pods                          # wait until the app's pod is gone
    ```

2. Restore into the existing PVC. `enableFileDeletion` makes the volume match the
   snapshot exactly, so files created after it are removed. Apply this by hand;
   it is deliberately not in Git, because a ReplicationDestination in Git would
   overwrite live data whenever it is applied, including on a fresh cluster.

    ```yaml
    apiVersion: volsync.backube/v1alpha1
    kind: ReplicationDestination
    metadata:
        name: <app>-restore
        namespace: <ns>
    spec:
        trigger:
            manual: restore-1 # change the value to run again
        restic:
            repository: <app>-volsync
            copyMethod: Direct
            destinationPVC: <pvc>
            enableFileDeletion: true
            # restoreAsOf: "2026-10-26T10:00:00Z"   # the newest snapshot at or before this time
            # previous: 1                           # or: skip this many newer snapshots
            cacheCapacity: 512Mi
            cacheStorageClassName: local-path
            # <node> is where the app must run. With an existing PVC that is the
            # PV's node; with a recreated one (node lost) the new PV is created on
            # whichever node the mover reaches first, so name the right one.
            moverAffinity:
                nodeAffinity:
                    requiredDuringSchedulingIgnoredDuringExecution:
                        nodeSelectorTerms:
                            - matchExpressions:
                                  - key: kubernetes.io/hostname
                                    operator: In
                                    values:
                                        - <node>
            moverSecurityContext:
                runAsNonRoot: true
                runAsUser: 568
                runAsGroup: 568
                fsGroup: 568
                fsGroupChangePolicy: OnRootMismatch
                seccompProfile:
                    type: RuntimeDefault
            moverVolumes:
                - mountPath: repo
                  volumeSource:
                      persistentVolumeClaim:
                          claimName: <app>-volsync-repo
    ```

    With neither `restoreAsOf` nor `previous` it restores the newest snapshot.
    Wait for `.status.latestMoverStatus.result` to be `Successful`, read the log
    (`kubectl -n <ns> logs job/volsync-dst-<app>-restore`), then delete the
    ReplicationDestination.

3. **SQLite apps: put the exported databases in place and check them.** The files
   restored in step 2 include the live databases as restic copied them, which
   may be torn. Apply this Job by hand (the image is the one in the
   `sqlite-export` CronJob), wait for it to complete, read its log and delete it.
   It first checks every export with `PRAGMA integrity_check`, and changes nothing
   if one fails. Then, for each database, it copies the export over the live file,
   removes the stale `-wal` and `-shm`, and runs `PRAGMA integrity_check` on the
   restored database.

    ```yaml
    apiVersion: batch/v1
    kind: Job
    metadata:
        name: <app>-sqlite-restore
        namespace: <ns>
    spec:
        backoffLimit: 0
        template:
            spec:
                restartPolicy: Never
                securityContext:
                    runAsNonRoot: true
                    runAsUser: <uid>
                    runAsGroup: <gid>
                    fsGroup: <gid>
                    seccompProfile:
                        type: RuntimeDefault
                containers:
                    - name: restore
                      image: <the image in the sqlite-export CronJob>
                      command: ["/bin/sh", "-ec"]
                      args:
                          - |
                              cd /data
                              list=$(find .sqlite-export -type f ! -name '*.tmp*')
                              test -n "$list"
                              for exp in $list; do
                                test "$(sqlite3 "$exp" 'PRAGMA integrity_check;')" = ok
                              done
                              for exp in $list; do
                                db=${exp#.sqlite-export/}
                                cp "$exp" "$db.restoring"
                                mv -f "$db.restoring" "$db"
                                rm -f "$db-wal" "$db-shm"
                                test "$(sqlite3 "$db" 'PRAGMA integrity_check;')" = ok
                                echo "restored $db"
                              done
                      securityContext:
                          allowPrivilegeEscalation: false
                          readOnlyRootFilesystem: true
                          capabilities:
                              drop:
                                  - ALL
                      volumeMounts:
                          - name: data
                            mountPath: /data
                volumes:
                    - name: data
                      persistentVolumeClaim:
                          claimName: <pvc>
    ```

    If the Job fails, the export it names is damaged. Do not start the app: repeat
    step 2 with `previous: 1` (or a `restoreAsOf` before the damage), which
    brings back an older volume with that day's exports, then repeat this step.
    When only a database is damaged and the rest of the volume is fine, skip
    step 2: run this Job on its own with the app stopped.

4. Start the app again:

    ```sh
    kubectl -n <ns> patch replicationsource <app> --type merge -p '{"spec":{"paused":false}}'
    flux resume helmrelease <app> -n <ns>
    flux resume kustomization <ks> -n <ns>
    ```

    Flux restores the replica count and sets the export CronJob's `suspend` back to
    false. For an app that Flux does not own, scale it back up yourself.

### If the node is lost

The PV is node-local, so the PVC is stuck on the dead node. The data is only in
the repository. Delete the PVC and its Retain PV, let Flux recreate an empty
PVC (suspend the app first so nothing writes to it), then run step 2 into the
new PVC with the app still stopped. Keep `moverAffinity` in that step: the new
PV is created on whichever node the mover lands on first, and the app has to
run there (Jellyfin: talos-01, for the GPU). Then continue with step 3.

### If the repository PVC is deleted

The repository PV has a `claimRef` to its PVC and `Retain`. Deleting the PVC
leaves the PV `Released`, and a new PVC of the same name will not bind until the
old claim's UID is cleared (the NFS data is not touched):

```sh
kubectl patch pv <app>-volsync-repo --type json -p '[{"op":"remove","path":"/spec/claimRef/uid"}]'
```
