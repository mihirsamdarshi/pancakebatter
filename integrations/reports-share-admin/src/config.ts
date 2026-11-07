import { z } from "zod";

export const DEFAULT_TOKEN_FILE = "/run/credentials/cloudflare-token";
export const DEFAULT_PORT = 8080;
// The probe port. It serves /healthz and nothing else, so a probe that comes
// from the node (and so cannot be told from any other process on the node)
// never reaches the write routes.
export const DEFAULT_HEALTH_PORT = 8081;
export const DEFAULT_POLICY_NAME = "reports-share guests";
// The Service name inside the cluster. Requests with any other Host are
// refused, so a stray route or a rebinding trick gets a 404. /healthz is the
// one exception (the kubelet probes the pod IP).
export const DEFAULT_ALLOWED_HOSTS = "share-admin.share-admin.svc.cluster.local:8080";

// IDs go into URL paths, so only plain characters are accepted. The account ID
// is 32 hex characters; the policy and application IDs are UUIDs. The loose
// pattern keeps the check simple and still blocks "../" and "?".
const Id = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, "must be 8 to 64 letters, digits or dashes");

const EnvSchema = z.object({
  CLOUDFLARE_ACCOUNT_ID: Id,
  ACCESS_POLICY_ID: Id,
  ACCESS_APP_ID: Id,
  CLOUDFLARE_TOKEN_FILE: z.string().min(1).default(DEFAULT_TOKEN_FILE),
  // Optional. Notification email is not switched on yet (see handler.ts).
  RESEND_KEY_FILE: z.string().min(1).optional(),
  // The name Terraform gives the guest policy (access.tf). A policy with
  // another name is not the one this service may edit.
  ACCESS_POLICY_NAME: z.string().min(1).default(DEFAULT_POLICY_NAME),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_HEALTH_PORT),
  PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_PORT),
  ALLOWED_HOSTS: z.string().min(1).default(DEFAULT_ALLOWED_HOSTS),
});

export interface Config {
  accountId: string;
  policyId: string;
  appId: string;
  policyName: string;
  tokenFile: string;
  resendKeyFile: string | undefined;
  port: number;
  healthPort: number;
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
  if (e.PORT === e.HEALTH_PORT)
    throw new Error("Bad configuration: PORT and HEALTH_PORT must differ");
  return {
    accountId: e.CLOUDFLARE_ACCOUNT_ID,
    policyId: e.ACCESS_POLICY_ID,
    appId: e.ACCESS_APP_ID,
    policyName: e.ACCESS_POLICY_NAME,
    tokenFile: e.CLOUDFLARE_TOKEN_FILE,
    resendKeyFile: e.RESEND_KEY_FILE,
    port: e.PORT,
    healthPort: e.HEALTH_PORT,
    allowedHosts: e.ALLOWED_HOSTS.split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  };
}
