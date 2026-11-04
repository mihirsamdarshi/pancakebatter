import { loadConfig } from "./config.ts";
import { KeyDirectory } from "./keys.ts";
import { createLogger } from "./log.ts";
import { Receiver } from "./receiver.ts";
import { createCappedServer } from "./server.ts";
import { openStore } from "./store.ts";

const log = createLogger();
let config;
try {
  config = loadConfig();
} catch (error) {
  // loadConfig messages are fixed strings that never contain a value.
  process.stderr.write((error instanceof Error ? error.message : "Invalid configuration") + "\n");
  process.exit(1);
}

const opened = openStore(config.dataDir, config.init);
if (opened.store) log("init", { reason: opened.created ? "created" : opened.resumed ? "resumed" : "existing" });
else log("init", { reason: opened.reason });

const keys = new KeyDirectory(config.credentials, config.apiBase);
const receiver = new Receiver(config, opened.store, opened.store ? null : opened.reason, keys, log);

const publicServer = createCappedServer((req) => receiver.handlePublic(req));
const internalServer = createCappedServer((req) => receiver.handleInternal(req));
publicServer.listen(config.port, config.host);
internalServer.listen(config.internalPort, config.host);
log("start");

// While the keyset cannot mint, retry a token mint every five minutes (the keys class limits it to
// one a minute) so BLOCKED key-unavailable clears without waiting for a notification. This runs
// only after a real failure, so it makes no production call before the first notification.
setInterval(() => {
  if (!keys.healthy()) void keys.probe();
}, 300_000).unref();

if (config.selfTest) {
  const tick = async () => {
    const code = "selftest" + Math.random().toString(36).slice(2, 10);
    const started = Date.now();
    try {
      const response = await fetch(config.endpoint + "?challenge_code=" + code, {
        redirect: "error",
        signal: AbortSignal.timeout(4000),
      });
      const body = (await response.json()) as { challengeResponse?: unknown };
      const ok = response.status === 200 && body.challengeResponse === receiver.challengeResponse(code);
      receiver.noteSelfTest(ok);
      log(ok ? "selftest-ok" : "selftest-failed", { ms: Date.now() - started });
    } catch {
      receiver.noteSelfTest(false);
      log("selftest-failed", { ms: Date.now() - started });
    }
  };
  setInterval(() => void tick(), 300_000).unref();
}

for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    log("stopped");
    publicServer.close();
    internalServer.close();
    opened.store?.close();
    process.exit(0);
  });
