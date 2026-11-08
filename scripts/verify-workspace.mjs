import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { preparePackageArtifacts } from "./prepare-package-artifacts.mjs";
import { verificationOptions } from "./verification-options.mjs";
import { archiveDigest } from "./release-artifacts.mjs";
import assert from "node:assert/strict";
import { verificationPlan } from "./verification-plan.mjs";
const repository = fileURLToPath(new URL("..", import.meta.url));
const options = verificationOptions(process.argv.slice(2));
const directory = options.directory ?? mkdtempSync(join(tmpdir(), "kozane-verification-"));
const run = (command, parameters) =>
  execFileSync(command, parameters, { cwd: repository, stdio: "inherit" });
try {
  const artifacts =
    options.mode === "reuse" ? undefined : preparePackageArtifacts({ repository, directory, run });
  for (const [command, parameters] of verificationPlan(directory, options))
    run(command, parameters);
  for (const artifact of artifacts ?? [])
    assert.equal(
      archiveDigest(join(directory, artifact.file)),
      artifact.sha256,
      "Verification modified a prepared archive",
    );
  if (options.mode === "retain") console.log(`Verified archives retained at ${directory}`);
} finally {
  if (options.mode === "temporary") rmSync(directory, { recursive: true, force: true });
}
