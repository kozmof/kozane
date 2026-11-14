import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("release candidates distinguish version pins and shared release inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "release-candidates-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (path, value) => writeFileSync(join(root, path), value);
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "packages/client"), { recursive: true });
    mkdirSync(join(root, "drizzle"));
    copyFileSync(new URL("./check-release-candidates.mjs", import.meta.url), join(root, "scripts/check-release-candidates.mjs"));
    git("init", "--quiet");
    git("config", "commit.gpgsign", "false");
    mkdirSync(join(root, "empty-hooks"));
    git("config", "core.hooksPath", join(root, "empty-hooks"));
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    const manifest = (pin, version = "1.0.0") => JSON.stringify({ version, peerDependencies: { "@kozane/core": pin } });
    const commit = () => { git("add", "."); git("commit", "--quiet", "-m", "fixture"); return git("rev-parse", "HEAD"); };
    const compare = (from, to) => execFileSync(process.execPath, ["scripts/check-release-candidates.mjs", from, to], { cwd: root, encoding: "utf8" });
    write("packages/client/package.json", manifest("1.0.0"));
    const initial = commit();
    write("packages/client/package.json", manifest("2.0.0", "2.0.0"));
    let previous = commit();
    assert.match(compare(initial, previous), /No release candidates/);
    for (const pin of ["^2.0.0", "^3.0.0", "file:../core-1.0.0", "file:../core-2.0.0", "git+https:\/\/example.com/core#1.0.0", "git+https:\/\/example.com/core#2.0.0"]) {
      write("packages/client/package.json", manifest(pin));
      const next = commit();
      assert.match(compare(previous, next), /@kozane\/client:/);
      previous = next;
    }
    write("packages/client/package.json", manifest("workspace:1.0.0"));
    previous = commit();
    write("packages/client/package.json", manifest("workspace:2.0.0"));
    const workspaceBump = commit();
    assert.match(compare(previous, workspaceBump), /No release candidates/);
    previous = workspaceBump;
    write("README.md", "Published readme");
    let next = commit();
    assert.match(compare(previous, next), /  kozane:/);
    previous = next;
    write("drizzle/0001.sql", "select 1;");
    next = commit();
    const output = compare(previous, next);
    for (const name of ["@kozane/core:", "@kozane/client:", "kozane:"]) assert.ok(output.includes(name));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
