import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { preparePackageArtifacts } from "./prepare-package-artifacts.mjs";
import { verificationPlan } from "./verification-plan.mjs";
const repository = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || args.some((arg) => !arg.startsWith("--artifacts=")))
  throw new Error("Usage: verify-workspace.mjs [--artifacts=<directory>]");
const supplied = args[0]?.slice("--artifacts=".length);
const directory = supplied
  ? resolve(supplied)
  : mkdtempSync(join(tmpdir(), "kozane-verification-"));
const run = (command, parameters) =>
  execFileSync(command, parameters, { cwd: repository, stdio: "inherit" });
try {
  if (!supplied) preparePackageArtifacts({ repository, directory, run });
  for (const [command, parameters] of verificationPlan(directory)) run(command, parameters);
} finally {
  if (!supplied) rmSync(directory, { recursive: true, force: true });
}
