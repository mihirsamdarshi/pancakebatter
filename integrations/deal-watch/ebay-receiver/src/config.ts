import { readFileSync } from "node:fs";

export interface Credentials {
  clientId: string;
  clientSecret: string;
}

export interface Config {
  /** The exact public URL typed into the eBay portal. Hashed byte for byte; never the Host header. */
  endpoint: string;
  /** Pathname of `endpoint`: the one routed path on the public port. */
  endpointPath: string;
  verificationToken: string;
  credentials: Credentials;
  apiBase: string;
  dataDir: string;
  init: "allow" | "deny";
  port: number;
  internalPort: number;
  host: string;
  /** Probe our own public endpoint every five minutes. Off unless SELF_TEST=1 (needs the public URL to exist). */
  selfTest: boolean;
}

/** Fixed message: a failure here must never echo a value. */
const fail = (what: string): never => {
  throw new Error("Invalid configuration: " + what);
};

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function parseCredentials(body: string): Credentials {
  try {
    if (Buffer.byteLength(body) > 16384) throw Error();
    const value: unknown = JSON.parse(body);
    if (!object(value) || Object.keys(value).some((k) => !["clientId", "clientSecret"].includes(k))) throw Error();
    for (const key of ["clientId", "clientSecret"])
      if (
        typeof value[key] !== "string" ||
        !value[key].length ||
        value[key].length > 4096 ||
        /[\s\x00-\x1f\x7f:]/.test(value[key])
      )
        throw Error();
    return value as unknown as Credentials;
  } catch {
    return fail("eBay credential file");
  }
}

const TOKEN = /^[A-Za-z0-9_-]{32,80}$/;

function readSecret(env: Record<string, string | undefined>, name: string): string | undefined {
  const file = env[name + "_FILE"];
  if (file) {
    try {
      return readFileSync(file, "utf8").replace(/\r?\n$/, "");
    } catch {
      return fail(name + " file");
    }
  }
  return env[name];
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const local = env.ALLOW_LOCAL_HTTP === "1";
  const endpoint = env.ENDPOINT_URL ?? "";
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return fail("ENDPOINT_URL");
  }
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    endpoint.includes("?") ||
    endpoint.includes("#")
  )
    fail("ENDPOINT_URL");
  if (!local && (!url.hostname.includes(".") || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")))
    fail("ENDPOINT_URL host");
  const verificationToken = readSecret(env, "VERIFICATION_TOKEN") ?? "";
  if (!TOKEN.test(verificationToken)) fail("verification token");
  const credentialFile = env.EBAY_CREDENTIALS_FILE;
  let credentials: Credentials;
  try {
    credentials = parseCredentials(readFileSync(credentialFile ?? "", "utf8"));
  } catch {
    return fail("eBay credential file");
  }
  const apiBase = env.EBAY_API_BASE ?? "https://api.ebay.com";
  if (apiBase !== "https://api.ebay.com" && !(local && /^http:\/\/127\.0\.0\.1:\d+$/.test(apiBase)))
    fail("EBAY_API_BASE");
  const initValue = env.RECEIVER_INIT ?? "deny";
  if (initValue !== "allow" && initValue !== "deny") return fail("RECEIVER_INIT");
  const init: "allow" | "deny" = initValue;
  const port = Number(env.PORT ?? 3000);
  const internalPort = Number(env.INTERNAL_PORT ?? 3001);
  for (const p of [port, internalPort]) if (!Number.isInteger(p) || p < 0 || p > 65535) fail("port");
  if (port !== 0 && port === internalPort) fail("port");
  return {
    endpoint,
    endpointPath: url.pathname,
    verificationToken,
    credentials,
    apiBase,
    dataDir: env.DATA_DIR ?? "/data",
    init,
    port,
    internalPort,
    host: env.HOST ?? "0.0.0.0",
    selfTest: env.SELF_TEST === "1",
  };
}
