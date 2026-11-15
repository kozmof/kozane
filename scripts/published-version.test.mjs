import assert from "node:assert/strict";
import { test } from "node:test";
import { publishedVersion } from "./published-version.mjs";
const metadata = { name: "@kozane/core", version: "0.2.0", dist: { integrity: "sha512-test" } };
const check = (status, body = metadata) => publishedVersion("@kozane/core", "0.2.0", "sha512-test", async (url) => {
  assert.equal(url, "https://registry.npmjs.org/%40kozane%2Fcore/0.2.0");
  return { status, json: async () => body };
});
test("skips matching published archives", async () => assert.equal(await check(200), true));
test("only a registry 404 permits publication", async () => {
  assert.equal(await check(404), false);
  for (const status of [401, 403, 429, 500]) await assert.rejects(check(status), /registry HTTP/);
});
test("rejects existing versions with different bytes", async () => {
  await assert.rejects(check(200, { ...metadata, dist: { integrity: "different" } }), /new version/);
});
test("network failures stop publication", async () => {
  await assert.rejects(publishedVersion("x", "1.0.0", "sha512-test", async () => { throw new Error("offline"); }), /offline/);
});
