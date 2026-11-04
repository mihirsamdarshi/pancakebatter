import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { ENDPOINT, TOKEN, tempDir, writeFiles } from "./testkit.ts";

const base = () => {
  const f = writeFiles(tempDir());
  return { ENDPOINT_URL: ENDPOINT, VERIFICATION_TOKEN_FILE: f.token, EBAY_CREDENTIALS_FILE: f.creds };
};

describe("config", () => {
  test("reads token and credentials from mounted files; path comes from the endpoint", () => {
    const c = loadConfig(base());
    expect(c.verificationToken).toBe(TOKEN);
    expect(c.endpoint).toBe(ENDPOINT);
    expect(c.endpointPath).toBe("/ebay/notify");
    expect(c.init).toBe("deny");
    expect(c.apiBase).toBe("https://api.ebay.com");
    expect(c.selfTest).toBe(false);
  });
  test("token can come from the environment", () => {
    const { VERIFICATION_TOKEN_FILE: _f, ...rest } = base();
    expect(loadConfig({ ...rest, VERIFICATION_TOKEN: TOKEN }).verificationToken).toBe(TOKEN);
  });
  test.each([
    ["http endpoint", { ENDPOINT_URL: "http://ebay-notify.example.test/x" }],
    ["localhost endpoint", { ENDPOINT_URL: "https://localhost/x" }],
    ["ip endpoint", { ENDPOINT_URL: "https://10.0.0.5/x" }],
    ["endpoint with query", { ENDPOINT_URL: ENDPOINT + "?a=1" }],
    ["endpoint with userinfo", { ENDPOINT_URL: "https://u:p@ebay-notify.example.test/x" }],
    ["short token", { VERIFICATION_TOKEN_FILE: undefined, VERIFICATION_TOKEN: "short" }],
    ["bad token chars", { VERIFICATION_TOKEN_FILE: undefined, VERIFICATION_TOKEN: "a".repeat(31) + "!" }],
    ["api base override without local flag", { EBAY_API_BASE: "http://127.0.0.1:9" }],
    ["bad init", { RECEIVER_INIT: "yes" }],
    ["same ports", { PORT: "3000", INTERNAL_PORT: "3000" }],
  ])("rejects %s with a message that holds no value", (_n, over) => {
    let message = "";
    try {
      loadConfig({ ...base(), ...over });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toStartWith("Invalid configuration");
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain("example.test");
  });
});
