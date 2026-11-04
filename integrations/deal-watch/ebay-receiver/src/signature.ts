import { createPublicKey, verify, type KeyObject } from "node:crypto";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

export interface SignatureHeader {
  kid: string;
  signature: Buffer;
}

/**
 * X-EBAY-SIGNATURE is base64 of JSON {alg, kid, signature, digest} (eBay Node SDK test vectors).
 * Only `kid` and `signature` are used. `alg` and `digest` come from the header an attacker can
 * write, so the algorithm and digest are taken from the key response instead.
 * Never throws a message that contains the header.
 */
export function parseSignatureHeader(value: string | undefined): SignatureHeader | null {
  if (!value || value.length > 2048 || !B64.test(value)) return null;
  try {
    const json: unknown = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    if (!json || typeof json !== "object" || Array.isArray(json)) return null;
    const { kid, signature } = json as Record<string, unknown>;
    if (typeof kid !== "string" || !UUID.test(kid)) return null;
    if (typeof signature !== "string" || signature.length > 512 || !B64.test(signature)) return null;
    const bytes = Buffer.from(signature, "base64");
    if (bytes.length < 8) return null;
    return { kid, signature: bytes };
  } catch {
    return null;
  }
}

export type Digest = "sha1" | "sha256";

export interface PublicKey {
  key: KeyObject;
  digest: Digest;
}

/** Parses the getPublicKey response. Returns null for anything outside ECDSA with SHA1 or SHA256. */
export function parsePublicKey(body: unknown): PublicKey | null {
  try {
    if (!body || typeof body !== "object") return null;
    const { key, algorithm, digest } = body as Record<string, unknown>;
    if (typeof key !== "string" || key.length > 4096) return null;
    if (typeof algorithm !== "string" || algorithm.trim().toUpperCase() !== "ECDSA") return null;
    const d = typeof digest === "string" ? digest.trim().toUpperCase().replace("-", "") : "";
    if (d !== "SHA1" && d !== "SHA256") return null;
    // The service returns the PEM armor with no line breaks. Decode the base64 body directly.
    const b64 = key.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
    if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
    const parsed = createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
    if (parsed.asymmetricKeyType !== "ec") return null;
    return { key: parsed, digest: d === "SHA1" ? "sha1" : "sha256" };
  } catch {
    return null;
  }
}

/**
 * The SDK signs JSON.stringify(parsedBody), not raw bytes. A genuine notification passes one of the
 * two forms; a forgery passes neither. Both checks use the one public key and digest.
 */
export function verifyNotification(pk: PublicKey, signature: Buffer, raw: Buffer): boolean {
  const attempt = (data: Buffer): boolean => {
    try {
      return verify(pk.digest, data, pk.key, signature);
    } catch {
      return false;
    }
  };
  if (attempt(raw)) return true;
  try {
    const canonical = Buffer.from(JSON.stringify(JSON.parse(raw.toString("utf8"))), "utf8");
    return !canonical.equals(raw) && attempt(canonical);
  } catch {
    return false;
  }
}
