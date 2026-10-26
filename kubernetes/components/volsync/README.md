# volsync component

Nightly restic backup of one app's config PVC to the TrueNAS share
`192.168.10.75:/mnt/nasty/Backups/volsync`, one repository directory per app.
The operator is in `kubernetes/apps/volsync-system`.

The component adds, per app: a `ReplicationSource`, the NFS PV and PVC that the
mover mounts at `/mnt/repo`, and the restic Secret (SOPS; one password shared by
all repositories, and `RESTIC_REPOSITORY=/mnt/repo/<app>`).

What it protects against: loss of a node's disk or VM, a corrupted or deleted
config. It does not protect against losing the host or TrueNAS, because the NAS
VM runs on the same machine as the cluster. Offsite copies are a later decision.

## Add an app

1. In the app's `kustomization.yaml`, add the component:

    ```yaml
    components:
        - ../../../../components/volsync # adjust the number of ../
    ```

2. In the app's Flux `ks.yaml`, wait for the operator and set the variables:

    ```yaml
    spec:
        dependsOn:
            - name: volsync
              namespace: volsync-system
        postBuild:
            substitute:
                APP: sonarr # names the ReplicationSource, Secret, PV/PVC and repository directory
                VOLSYNC_CLAIM: sonarr-config # the PVC to back up
                VOLSYNC_SCHEDULE: "30 10 * * *" # optional, UTC
    ```

3. Back up the config volume only. Leave out anything a restart regenerates
   (caches, artwork, transcodes).

Mover pods run as 568:568 (the TrueNAS `apps` user), so the app's files must be
readable by 568. Direct mode needs no snapshots, but the app keeps running
during the backup: see the SQLite note below.

### Schedule slots

The default is `0 10 * * *`: 10:00 UTC, which is 03:00 Pacific in summer and
02:00 in winter. Give each app its own slot, 15 minutes apart, so movers never
overlap on a node.

| App           | Slot (UTC)            |
| ------------- | --------------------- |
| jellyfin      | 10:00                 |
| quilt-planner | 10:15                 |
| next apps     | 10:30, 10:45, 11:00 … |

## SQLite

Direct mode reads the live files. A SQLite database in WAL mode is three files
(`db`, `db-wal`, `db-shm`) that must agree; a write between restic reading the
first and the last can produce a copy that does not open cleanly, and restic
cannot tell. The schedule is in the quiet hours and seven dailies plus four
weeklies are kept, so one bad copy is not fatal, but an app whose database
matters should also write its own consistent export (an app-native backup, or
`sqlite3 .backup`) before the slot, so that the export is captured too.

## Restore

There are no CSI snapshots, so a restore writes straight into the existing PVC
and the app must be stopped first. Replace `<app>`, `<ns>` and `<pvc>`. The restic
password is in 1Password and in `secret.sops.yaml`
(`sops decrypt --extract '["stringData"]["RESTIC_PASSWORD"]' kubernetes/components/volsync/secret.sops.yaml`).

1. Stop the app, and stop Flux and the nightly run from undoing or racing it.
   Suspend the Flux Kustomization(s) that own the app and its ReplicationSource
   (for Jellyfin that is one, `jellyfin`; Quilt has `quilt-planner` and
   `quilt-planner-backup`):

    ```sh
    flux suspend kustomization <ks> -n <ns>
    flux suspend helmrelease <app> -n <ns>            # HelmRelease apps only
    kubectl -n <ns> patch replicationsource <app> --type merge -p '{"spec":{"paused":true}}'
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

3. Start the app again:

    ```sh
    kubectl -n <ns> patch replicationsource <app> --type merge -p '{"spec":{"paused":false}}'
    flux resume helmrelease <app> -n <ns>
    flux resume kustomization <ks> -n <ns>
    ```

    Flux restores the replica count. For an app that Flux does not own, scale it
    back up yourself.

### If the node is lost

The PV is node-local, so the PVC is stuck on the dead node. The data is only in
the repository. Delete the PVC and its Retain PV, let Flux recreate an empty
PVC (suspend the app first so nothing writes to it), then run step 3 into the
new PVC with the app still stopped.
