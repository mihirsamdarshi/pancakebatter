import { Database } from "bun:sqlite";
import { closeSync, existsSync, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * Tier 1 storage design: the app stores no eBay seller identity, so this file holds none either.
 * Bump only with a reviewed change; the worker compares this value (design section 3.6).
 */
export const STORAGE_DESIGN_VERSION = "tier1-v1";
export const STALE_MS = 10 * 60 * 1000;

export type BlockReason = "volume-reset" | "db-unreadable";

export interface Recorded {
  /** Opaque eBay notification id (not a user identifier). */
  id: string;
  eventDate: string;
  publishAttemptCount: number;
}

export class Store {
  constructor(
    private readonly db: Database,
    readonly instanceId: string,
  ) {}

  /** One transaction, synchronous=FULL: the row is on disk before this returns. */
  record(n: Recorded, now: number): "new" | "duplicate" {
    const tx = this.db.transaction(() => {
      const inserted = this.db
        .query(
          "INSERT OR IGNORE INTO notifications (notification_id, received_at, event_date, publish_attempt_count, state, cleared_at) VALUES (?, ?, ?, ?, 'received', NULL)",
        )
        .run(n.id, now, n.eventDate, n.publishAttemptCount);
      if (inserted.changes === 0) return "duplicate" as const;
      // Tier 1: nothing identifying is stored anywhere, so "cleared" is an attestation of the
      // storage design version, not a proof. The worker-side audit is the proof (design 3.3).
      this.db.query("UPDATE notifications SET state = 'cleared', cleared_at = ? WHERE notification_id = ?").run(now, n.id);
      return "new" as const;
    });
    return tx();
  }

  /** Throws if the database is unreadable. */
  staleCount(now: number): number {
    const row = this.db
      .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM notifications WHERE state != 'cleared' AND received_at < ?")
      .get(now - STALE_MS);
    return row?.n ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notifications (
  notification_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  event_date TEXT NOT NULL,
  publish_attempt_count INTEGER NOT NULL,
  state TEXT NOT NULL,
  cleared_at INTEGER
);`;

function pragmas(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA busy_timeout = 2000");
}

function writeMarker(path: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, "initialized\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export type OpenResult =
  | { store: Store; created: boolean; resumed: boolean }
  | { store: null; reason: BlockReason };

/**
 * First-run procedure, design 3.6:
 *  - database and marker both absent and init=allow: create, then write the marker last;
 *  - both present: open;
 *  - database present, marker absent: only a crash between the two steps of a first run. With
 *    init=allow, finish by writing the marker. Otherwise BLOCKED;
 *  - marker present, database absent, or both absent with init=deny: BLOCKED volume-reset.
 */
export function openStore(dir: string, init: "allow" | "deny"): OpenResult {
  const dbPath = join(dir, "receiver.db");
  const markerPath = join(dir, ".initialized");
  try {
    const hasDb = existsSync(dbPath);
    const hasMarker = existsSync(markerPath);
    if (!hasDb && hasMarker) return { store: null, reason: "volume-reset" };
    if (!hasDb && !hasMarker) {
      if (init !== "allow") return { store: null, reason: "volume-reset" };
      const db = new Database(dbPath, { create: true, readwrite: true });
      pragmas(db);
      db.exec(SCHEMA);
      const instanceId = crypto.randomUUID();
      db.query("INSERT INTO meta (key, value) VALUES ('instance_id', ?), ('design_version', ?)").run(
        instanceId,
        STORAGE_DESIGN_VERSION,
      );
      writeMarker(markerPath);
      return { store: new Store(db, instanceId), created: true, resumed: false };
    }
    if (hasDb && !hasMarker && init !== "allow") return { store: null, reason: "volume-reset" };
    const db = new Database(dbPath, { create: false, readwrite: true });
    pragmas(db);
    const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'instance_id'").get();
    if (!row) {
      db.close();
      return { store: null, reason: "db-unreadable" };
    }
    if (!hasMarker) writeMarker(markerPath);
    return { store: new Store(db, row.value), created: false, resumed: !hasMarker };
  } catch {
    return { store: null, reason: "db-unreadable" };
  }
}
