import { archiveName } from "../release-artifacts.mjs";
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { lockedDriver } from "../compatibility/locked-driver.mjs";
/** Add the packed client and its exact runtime graph to the existing isolated core consumer. */
export function prepareClientConsumer({
  consumer,
  repository,
  run,
  coreReference,
  coreVersion,
  artifacts,
}) {
  if (artifacts) {
    const pkg = JSON.parse(readFileSync(join(repository, "packages/client/package.json"), "utf8"));
    copyFileSync(join(artifacts, archiveName(pkg)), join(consumer, archiveName(pkg)));
  } else run("pnpm", ["--filter", "@kozane/client", "pack", "--pack-destination", consumer]);
  const name = readdirSync(consumer).find(
    (name) => name.startsWith("kozane-client-") && name.endsWith(".tgz"),
  );
  assert.ok(name, "Missing client archive");
  const archive = join(consumer, name);
  const manifest = JSON.parse(run("tar", ["-xOf", archive, "package/package.json"]));
  const entries = run("tar", ["-tzf", archive]).trim().split("\n");
  assert.ok(entries.includes("package/LICENCE") && entries.includes("package/README.md"));
  assert.ok(entries.includes("package/dist/board/BoardView.svelte"));
  assert.ok(entries.includes("package/dist/styles.css"));
  assert.ok(manifest.sideEffects.includes("**/*.css"));
  assert.equal(manifest.exports["./styles.css"], "./dist/styles.css");
  assert.ok(
    entries.every(
      (entry) => !entry.startsWith("package/tmp/") && !entry.startsWith("package/src/"),
    ),
  );
  assert.equal(manifest.peerDependencies["@kozane/core"], coreVersion);
  assert.equal(manifest.devDependencies["@kozane/core"], coreVersion);
  assert.deepEqual(Object.keys(manifest.dependencies), ["@kozmof/reed"]);
  const svelte = JSON.parse(
    readFileSync(join(repository, "node_modules/svelte/package.json"), "utf8"),
  ).version;
  const reference = `file:${archive}`;
  const key = JSON.stringify(`@kozane/client@${reference}`);
  const integrity = "sha512-" + createHash("sha512").update(readFileSync(archive)).digest("base64");
  const lock = readFileSync(join(repository, "pnpm-lock.yaml"), "utf8");
  const graphs = [`svelte@${svelte}`, `@kozmof/reed@${manifest.dependencies["@kozmof/reed"]}`].map(
    (key) => lockedDriver(lock, key),
  );
  const packagePath = join(consumer, "package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  pkg.dependencies["@kozane/client"] = reference;
  pkg.dependencies.svelte = svelte;
  writeFileSync(packagePath, JSON.stringify(pkg));
  return {
    manifest,
    importer: `      '@kozane/client':\n        specifier: ${JSON.stringify(reference)}\n        version: ${JSON.stringify(reference)}\n      svelte:\n        specifier: ${svelte}\n        version: ${svelte}\n`,
    packages:
      `  ${key}:\n    resolution: {integrity: ${integrity}, tarball: ${JSON.stringify(reference)}}\n    version: ${manifest.version}\n    peerDependencies:\n      '@kozane/core': ${manifest.peerDependencies["@kozane/core"]}\n      svelte: ${manifest.peerDependencies.svelte}\n` +
      graphs.map((graph) => graph.packages).join("\n"),
    snapshots:
      `  ${key}:\n    dependencies:\n      '@kozane/core': ${JSON.stringify(coreReference)}\n      svelte: ${svelte}\n      '@kozmof/reed': ${manifest.dependencies["@kozmof/reed"]}\n` +
      graphs.map((graph) => graph.snapshots).join("\n"),
  };
}
