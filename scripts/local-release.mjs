import { archiveName, archiveDigest, validateReleaseArtifacts } from "./release-artifacts.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });
const output = (command, args) =>
  execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();

const packages = ["core", "client", "kozane"].map((directory) => ({
  directory,
  ...JSON.parse(readFileSync(join(root, "packages", directory, "package.json"), "utf8")),
}));
const [mode = "prepare", argument, ...extra] = process.argv.slice(2);
assert.ok(
  ["prepare", "publish"].includes(mode) && !extra.length,
  "Usage: local-release.mjs prepare [directory] | publish <directory>",
);
assert.equal(
  output("git", ["status", "--porcelain"]),
  "",
  "Commit source changes before preparing or publishing a release",
);
const commit = output("git", ["rev-parse", "HEAD"]);
const directory = resolve(argument ?? join(root, "tmp", "releases", commit));
const manifestPath = join(directory, "release.json");
if (mode === "prepare") {
  assert.ok(!existsSync(manifestPath), "Release directory already contains a prepared release");
  for (const script of ["release:check", "verify", "audit:production", "smoke:package", "test:e2e"])
    run("pnpm", [script]);
  for (const script of ["test:restoration-harness", "test:client-package"]) run("pnpm", [script]);
  mkdirSync(directory, { recursive: true });
  const artifacts = packages.map((pkg) => {
    run("pnpm", ["--filter", pkg.name, "pack", "--pack-destination", directory]);
    const file = archiveName(pkg);
    const archive = join(directory, file);
    run("npm", [
      "publish",
      archive,
      "--access",
      "public",
      "--ignore-scripts",
      "--dry-run",
      "--registry=https://registry.npmjs.org/",
    ]);
    return { name: pkg.name, version: pkg.version, file, sha256: archiveDigest(archive) };
  });
  run(process.execPath, ["scripts/smoke-package.mjs", "--artifacts=" + directory]);
  assert.equal(
    output("git", ["status", "--porcelain"]),
    "",
    "Release checks changed tracked source",
  );
  writeFileSync(manifestPath, JSON.stringify({ format: 1, commit, artifacts }, null, 2) + "\n");
  console.log(`Prepared local release at ${directory}. Nothing was published.`);
} else {
  assert.ok(argument, "Publishing requires the prepared release directory");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  validateReleaseArtifacts(manifest, packages, commit, directory);
  run("pnpm", ["release:check"]);
  run("npm", ["whoami", "--registry=https://registry.npmjs.org/"]);
  for (const artifact of manifest.artifacts) {
    const existing = spawnSync(
      "npm",
      [
        "view",
        artifact.name + "@" + artifact.version,
        "dist.integrity",
        "--json",
        "--registry=https://registry.npmjs.org/",
        "--fetch-retries=0",
      ],
      { cwd: root, encoding: "utf8" },
    );
    if (existing.status === 0) {
      const integrity =
        "sha512-" +
        createHash("sha512")
          .update(readFileSync(join(directory, artifact.file)))
          .digest("base64");
      assert.equal(
        JSON.parse(existing.stdout),
        integrity,
        "Published version contains different bytes",
      );
      console.log(artifact.name + "@" + artifact.version + " already matches the prepared archive");
      continue;
    }
    let error;
    try {
      error = JSON.parse(existing.stdout).error?.code;
    } catch {
      /* npm may report a non-JSON connection error. */
    }
    assert.equal(error, "E404", existing.stderr || "Cannot check existing registry version");
    run("npm", [
      "publish",
      join(directory, artifact.file),
      "--access",
      "public",
      "--ignore-scripts",
      "--registry=https://registry.npmjs.org/",
    ]);
  }
  run("pnpm", ["release:verify:registry"]);
}
