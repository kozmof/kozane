import { copyFileSync } from "node:fs";
import { join } from "node:path";
/** Run actual public ESM resolution in the isolated consumer, not the repository. */
export function checkCoreRuntime({ consumer, run, manifest }) {
  for (const name of ["core-graph.mjs", "runtime-identity.mjs", "verify-core-identity.mjs"])
    copyFileSync(new URL(name, import.meta.url), join(consumer, name));
  console.log(
    run(
      process.execPath,
      [
        "--experimental-import-meta-resolve",
        join(consumer, "runtime-identity.mjs"),
        JSON.stringify({
          core: manifest.peerDependencies["@kozane/core"],
          client: manifest.version,
        }),
      ],
      consumer,
    ).trim(),
  );
}
