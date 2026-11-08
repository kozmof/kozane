import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const repository = resolve(import.meta.dirname, "..");
test("normal core builds reject stale generated migrations and schema without rewriting them", () => {
  const app = JSON.parse(readFileSync(join(repository, "packages/kozane/package.json"), "utf8"));
  assert.ok(!app.scripts["build:app"].includes("generate"));
  const root = mkdtempSync(join(tmpdir(), "kozane-migration-build-"));
  try {
    mkdirSync(join(root, "packages/core"), { recursive: true });
    cpSync(join(repository, "drizzle"), join(root, "drizzle"), { recursive: true });
    for (const name of ["src", "scripts"])
      cpSync(join(repository, "packages/core", name), join(root, "packages/core", name), {
        recursive: true,
      });
    symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir");
    const run = (script, args = []) =>
      spawnSync(process.execPath, [join(root, "packages/core/scripts", script), ...args], {
        encoding: "utf8",
      });
    for (const [name, generator] of [
      ["migrations", "generate-migrations.mjs"],
      ["schema-manifest", "generate-schema.mjs"],
    ]) {
      const check = run(generator, ["--check"]);
      assert.equal(check.status, 0, check.stdout + check.stderr);
      const file = join(root, "packages/core/src/generated", name + ".ts");
      const original = readFileSync(file, "utf8");
      const stale = original + "\n// Deliberately stale generated artifact.\n";
      writeFileSync(file, stale);
      const build = run("build.mjs");
      assert.notEqual(build.status, 0);
      assert.match(build.stderr, /stale/);
      assert.equal(readFileSync(file, "utf8"), stale);
      writeFileSync(file, original);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
