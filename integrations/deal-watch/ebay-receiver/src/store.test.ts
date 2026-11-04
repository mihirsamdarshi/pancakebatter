import { describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "./store.ts";
import { tempDir } from "./testkit.ts";

describe("first-run procedure (design 3.6)", () => {
  test("both absent + allow: creates database then marker; CLEAR path", () => {
    const dir = tempDir();
    const r = openStore(dir, "allow");
    expect(r.store).not.toBeNull();
    expect(existsSync(join(dir, "receiver.db"))).toBe(true);
    expect(existsSync(join(dir, ".initialized"))).toBe(true);
  });
  test("both absent + deny: BLOCKED volume-reset, nothing created", () => {
    const dir = tempDir();
    expect(openStore(dir, "deny")).toEqual({ store: null, reason: "volume-reset" });
    expect(existsSync(join(dir, "receiver.db"))).toBe(false);
  });
  test("both present: reopens with same instance id, ignoring the setting", () => {
    const dir = tempDir();
    const a = openStore(dir, "allow");
    const id = a.store!.instanceId;
    a.store!.close();
    for (const mode of ["deny", "allow"] as const) {
      const b = openStore(dir, mode);
      expect(b.store!.instanceId).toBe(id);
      b.store!.close();
    }
  });
  test("database missing but marker present: volume-reset even with allow", () => {
    const dir = tempDir();
    openStore(dir, "allow").store!.close();
    for (const f of ["receiver.db", "receiver.db-wal", "receiver.db-shm"]) rmSync(join(dir, f), { force: true });
    expect(openStore(dir, "allow")).toEqual({ store: null, reason: "volume-reset" });
    expect(openStore(dir, "deny")).toEqual({ store: null, reason: "volume-reset" });
  });
  test("owner re-initialization: remove marker by hand with allow", () => {
    const dir = tempDir();
    openStore(dir, "allow").store!.close();
    for (const f of ["receiver.db", "receiver.db-wal", "receiver.db-shm", ".initialized"]) rmSync(join(dir, f), { force: true });
    expect(openStore(dir, "allow").store).not.toBeNull();
  });
  test("crash between database and marker: allow resumes, deny blocks", () => {
    const dir = tempDir();
    openStore(dir, "allow").store!.close();
    rmSync(join(dir, ".initialized"));
    expect(openStore(dir, "deny")).toEqual({ store: null, reason: "volume-reset" });
    const r = openStore(dir, "allow");
    expect(r.store).not.toBeNull();
    expect(existsSync(join(dir, ".initialized"))).toBe(true);
  });
  test("garbage database file or missing directory: db-unreadable", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "receiver.db"), "not a database at all, just text");
    writeFileSync(join(dir, ".initialized"), "x");
    expect(openStore(dir, "deny")).toEqual({ store: null, reason: "db-unreadable" });
    expect(openStore(join(dir, "nope"), "allow")).toEqual({ store: null, reason: "db-unreadable" });
  });
});
