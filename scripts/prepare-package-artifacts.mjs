import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { archiveName, archiveDigest } from "./release-artifacts.mjs";
/** Build once, then pack all three existing outputs without package lifecycle rebuilds. */
export function preparePackageArtifacts({ repository, directory, run }) {
  run("pnpm", ["build"]);
  mkdirSync(directory, { recursive: true });
  return ["core", "client", "kozane"].map((name) => {
    const pkg = JSON.parse(
      readFileSync(join(repository, "packages", name, "package.json"), "utf8"),
    );
    run("pnpm", [
      "--config.ignore-scripts=true",
      "--filter",
      pkg.name,
      "pack",
      "--pack-destination",
      directory,
    ]);
    const file = archiveName(pkg);
    return {
      name: pkg.name,
      version: pkg.version,
      file,
      sha256: archiveDigest(join(directory, file)),
    };
  });
}
