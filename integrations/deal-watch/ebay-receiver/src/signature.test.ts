import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import vectors from "../fixtures/ebay-sdk-test.json";
import { parsePublicKey, parseSignatureHeader, verifyNotification } from "./signature.ts";

const V = vectors.VALID;

describe("eBay SDK published vector", () => {
  const header = parseSignatureHeader(V.signature)!;
  const pk = parsePublicKey(V.response)!;
  test("header decodes to kid and signature", () => {
    expect(header.kid).toBe(V.public_key);
    expect(pk.digest).toBe("sha1");
  });
  test("compact body (what the SDK signs) verifies as raw bytes", () => {
    expect(verifyNotification(pk, header.signature, Buffer.from(JSON.stringify(V.message)))).toBe(true);
  });
  test("re-indented body verifies through the re-serialized form", () => {
    expect(verifyNotification(pk, header.signature, Buffer.from(JSON.stringify(V.message, null, 2)))).toBe(true);
  });
  test("INVALID vector (edited message) fails", () => {
    const bad = parseSignatureHeader(vectors.INVALID.signature)!;
    expect(verifyNotification(pk, bad.signature, Buffer.from(JSON.stringify(vectors.INVALID.message)))).toBe(false);
  });
  test("SIGNATURE_MISMATCH vector fails", () => {
    const bad = parseSignatureHeader(vectors.SIGNATURE_MISMATCH.signature)!;
    expect(verifyNotification(pk, bad.signature, Buffer.from(JSON.stringify(vectors.SIGNATURE_MISMATCH.message)))).toBe(false);
  });
  test("one changed byte fails", () => {
    const body = Buffer.from(JSON.stringify(V.message).replace("test_user", "test_usex"));
    expect(verifyNotification(pk, header.signature, body)).toBe(false);
  });
});

describe("header and key parsing", () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
  const sig = Buffer.alloc(70, 1).toString("base64");
  test.each([
    ["undefined", undefined],
    ["not base64", "***"],
    ["not json", Buffer.from("nope").toString("base64")],
    ["array", b64([])],
    ["bad kid", b64({ kid: "../etc", signature: sig })],
    ["no signature", b64({ kid: V.public_key })],
    ["oversized", "A".repeat(3000)],
  ])("rejects %s", (_n, value) => expect(parseSignatureHeader(value as string | undefined)).toBeNull());
  test("accepts well-formed header", () => expect(parseSignatureHeader(b64({ kid: V.public_key, signature: sig }))).not.toBeNull());
  test("key must be ECDSA with SHA1 or SHA256", () => {
    expect(parsePublicKey({ ...V.response, algorithm: "RSA" })).toBeNull();
    expect(parsePublicKey({ ...V.response, digest: "MD5" })).toBeNull();
    expect(parsePublicKey({ ...V.response, key: "garbage" })).toBeNull();
    expect(parsePublicKey(null)).toBeNull();
  });
  test("generated P-256 key and SHA256 round trip", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString().replace(/\n/g, "");
    const pk = parsePublicKey({ key: pem, algorithm: "ECDSA", digest: "SHA256" })!;
    const body = Buffer.from('{"a":1}');
    expect(verifyNotification(pk, sign("sha256", body, privateKey), body)).toBe(true);
    expect(verifyNotification(pk, sign("sha256", body, privateKey), Buffer.from('{"a":2}'))).toBe(false);
  });
});
