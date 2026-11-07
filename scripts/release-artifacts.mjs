import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
export const archiveName = (pkg) =>
  `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`;
export const archiveDigest = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
export function validateReleaseArtifacts(manifest, packages, commit, directory) {
  assert.equal(manifest.format, 1);
  assert.equal(manifest.commit, commit, "Prepared release must match the current commit");
  assert.equal(manifest.artifacts.length, packages.length);
  for (const [index, artifact] of manifest.artifacts.entries()) {
    const pkg = packages[index];
    assert.equal(artifact.name, pkg.name);
    assert.equal(artifact.version, pkg.version);
    assert.equal(artifact.file, archiveName(pkg));
    assert.equal(
      archiveDigest(join(directory, artifact.file)),
      artifact.sha256,
      "Prepared archive changed",
    );
  }
}
