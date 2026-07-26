import { mkdtempSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apiKeysEqual, readApiKey, requestApiKey, writeApiKey } from "./api-key";

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-api-key-"));
  mkdirSync(join(root, ".kozane"));
  return root;
}

describe("API key", () => {
  it("is disabled when the separate key file does not exist", () => {
    expect(readApiKey(workspace())).toBeNull();
  });

  it("reads a valid key file and rejects malformed credentials", () => {
    const root = workspace();
    const value = { apiKey: "secret", createdAt: "2026-07-19T00:00:00.000Z" };
    writeFileSync(join(root, ".kozane", "api.json"), JSON.stringify(value));
    expect(readApiKey(root)).toEqual(value);
    expect(apiKeysEqual("secret", value.apiKey)).toBe(true);
    expect(apiKeysEqual("wrong", value.apiKey)).toBe(false);
    expect(apiKeysEqual(undefined, value.apiKey)).toBe(false);
  });

  it("atomically writes a private key file", () => {
    const root = workspace();
    const value = { apiKey: "new-secret", createdAt: "2026-07-19T00:00:00.000Z" };

    writeApiKey(root, value);

    expect(readApiKey(root)).toEqual(value);
    expect(statSync(join(root, ".kozane", "api.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, ".kozane"))).toEqual(["api.json"]);
  });

  it("accepts bearer and X-API-Key credentials", () => {
    expect(
      requestApiKey(new Request("http://localhost", { headers: { authorization: "Bearer one" } })),
    ).toBe("one");
    expect(
      requestApiKey(new Request("http://localhost", { headers: { "x-api-key": "two" } })),
    ).toBe("two");
    expect(requestApiKey(new Request("http://localhost"), "three")).toBe("three");
  });
});
