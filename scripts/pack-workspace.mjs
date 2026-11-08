import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { preparePackageArtifacts } from "./prepare-package-artifacts.mjs";
import { verificationOptions } from "./verification-options.mjs";
const { mode, directory } = verificationOptions(process.argv.slice(2));
if (mode !== "retain") throw new Error("Usage: pack-workspace.mjs --output=<directory>");
const repository = resolve(import.meta.dirname, "..");
const artifacts = preparePackageArtifacts({
  repository,
  directory,
  run: (command, args) => execFileSync(command, args, { cwd: repository, stdio: "inherit" }),
});
console.log(JSON.stringify({ directory, artifacts }, null, 2));
