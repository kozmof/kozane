import assert from "node:assert/strict";
import { test } from "node:test";
import { autoRelease } from "./auto-release.mjs";

function fixture(prepared = false) {
  const calls = [];
  return {
    calls,
    root: "/repo",
    exists: () => prepared,
    output: (_, args) => (args[0] === "status" ? "" : "abc"),
    run: (_, args) => calls.push(args),
  };
}
test("prepares and publishes the same commit archives", () => {
  const f = fixture();
  autoRelease(f);
  assert.deepEqual(f.calls, [
    ["/repo/scripts/local-release.mjs", "prepare", "/repo/tmp/releases/abc"],
    ["/repo/scripts/local-release.mjs", "publish", "/repo/tmp/releases/abc"],
  ]);
});
test("resumes a prepared release without rebuilding", () => {
  const f = fixture(true);
  autoRelease(f);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1], "publish");
});
test("never publishes after preparation fails", () => {
  const f = fixture();
  f.run = (_, args) => {
    f.calls.push(args);
    throw new Error("checks failed");
  };
  assert.throws(() => autoRelease(f), /checks failed/);
  assert.equal(f.calls.length, 1);
});
test("rejects dirty checkouts and unexpected arguments before release commands", () => {
  for (const overrides of [{ args: ["unexpected"] }, { output: () => " M package.json" }]) {
    const f = fixture();
    assert.throws(() => autoRelease({ ...f, ...overrides }));
    assert.deepEqual(f.calls, []);
  }
});
