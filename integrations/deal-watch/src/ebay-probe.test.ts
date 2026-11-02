import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("probe dry run reads no credentials and makes no network requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ebay-probe-"));
  try {
    const guard = join(dir, "guard.ts");
    await writeFile(
      guard,
      'globalThis.fetch = (() => { throw new Error("UNEXPECTED_NETWORK"); }) as typeof fetch;',
    );
    for (const real of [false, true]) {
      const child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          guard,
          join(import.meta.dir, "../scripts/probe-ebay.ts"),
          "--mode",
          "item",
          "--id",
          "123456789012",
          "--zip",
          "10001",
          ...(real ? ["--probe"] : []),
        ],
        {
          stdin: new Response("synthetic-secret-invalid-json"),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(real ? 1 : 0);
      expect(out + err).not.toContain("synthetic-secret");
      expect(out + err).not.toContain("UNEXPECTED_NETWORK");
      if (!real) expect(JSON.parse(out).dryRun).toBe(true);
      else
        expect(JSON.parse(err).error).toBe("credentials-or-data-unavailable");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
