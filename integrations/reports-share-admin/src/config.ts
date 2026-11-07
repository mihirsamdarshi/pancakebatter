import { z } from "zod";

export const DEFAULT_TOKEN_FILE = "/run/credentials/cloudflare-token";
export const DEFAULT_PORT = 8080;
// The Service name inside the cluster. Requests with any other Host are
// refused, so a stray route or a rebinding trick gets a 404. /healthz is the
// one exception (the kubelet probes the pod IP).
export const DEFAULT_ALLOWED_HOSTS = "share-admin.share-admin.svc.cluster.local:8080";

// IDs go into URL paths, so only plain characters are accepted. The account
// and policy IDs are 32 hex characters and the application ID is a UUID; the
// loose pattern keeps the check simple and still blocks "../" and "?".
const Id = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, "must be 8 to 64 letters, digits or dashes");

const EnvSchema = z.object({
  CLOUDFLARE_ACCOUNT_ID: Id,
  ACCESS_POLICY_ID: Id,
  ACCESS_APP_ID: Id,
  CLOUDFLARE_TOKEN_FILE: z.string().min(1).default(DEFAULT_TOKEN_FILE),
  // Optional. Notification email is not switched on yet (see handler.ts).
  RESEND_KEY_FILE: z.string().min(1).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_PORT),
  ALLOWED_HOSTS: z.string().min(1).default(DEFAULT_ALLOWED_HOSTS),
});

export interface Config {
  accountId: string;
  policyId: string;
  appId: string;
  tokenFile: string;
  resendKeyFile: string | undefined;
  port: number;
  allowedHosts: readonly string[];
}

// Empty variables count as unset, so a Deployment can list them without values.
export function configFromEnv(env: Record<string, string | undefined>): Config {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ""),
  );
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success)
    throw new Error(
      `Bad configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  const e = parsed.data;
  return {
    accountId: e.CLOUDFLARE_ACCOUNT_ID,
    policyId: e.ACCESS_POLICY_ID,
    appId: e.ACCESS_APP_ID,
    tokenFile: e.CLOUDFLARE_TOKEN_FILE,
    resendKeyFile: e.RESEND_KEY_FILE,
    port: e.PORT,
    allowedHosts: e.ALLOWED_HOSTS.split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  };
}
