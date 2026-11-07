import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveName, archiveDigest, validateReleaseArtifacts } from "./release-artifacts.mjs";

const packages = [
  { name: "@kozane/core", version: "0.1.0" },
  { name: "@kozane/client", version: "0.1.0" },
  { name: "kozane", version: "0.22.0" },
];
for (const scenario of ["valid", "commit", "order", "version", "missing", "path", "bytes"]) {
  test(`local release artifacts: ${scenario}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "kozane-release-artifacts-"));
    try {
      const manifest = {
        format: 1,
        commit: "commit",
        artifacts: packages.map((pkg) => {
          const file = archiveName(pkg);
          writeFileSync(join(directory, file), pkg.name);
          return { ...pkg, file, sha256: archiveDigest(join(directory, file)) };
        }),
      };
      if (scenario === "commit") manifest.commit = "another";
      if (scenario === "order") manifest.artifacts.reverse();
      if (scenario === "version") manifest.artifacts[0].version = "0.0.1";
      if (scenario === "missing") manifest.artifacts.pop();
      if (scenario === "path") manifest.artifacts[0].file = "../outside.tgz";
      if (scenario === "bytes")
        writeFileSync(join(directory, manifest.artifacts[0].file), "changed");
      const verify = () => validateReleaseArtifacts(manifest, packages, "commit", directory);
      if (scenario === "valid") verify();
      else assert.throws(verify);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
