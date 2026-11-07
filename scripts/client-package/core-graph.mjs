import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, dirname, basename } from "node:path";

/** @param {string} root */
function manifest(root) {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}
/** @param {string} name @param {string} importer */
function resolvePackage(name, importer) {
  // ESM package lookup excludes CommonJS global NODE_PATH fallback directories.
  for (let directory = importer; ; directory = dirname(directory)) {
    if (basename(directory) !== "node_modules") {
      const root = join(directory, "node_modules", name);
      if (existsSync(join(root, "package.json"))) return realpathSync(root);
    }
    if (directory === dirname(directory)) break;
  }
  return null;
}
/** Inspect reachable installed runtime dependencies, following pnpm symlinks by real path. */
/** @param {string} root @param {{core: string, client: string}} expected */
export function inspectCoreGraph(root, expected) {
  root = realpathSync(root);
  const app = manifest(root);
  for (const name of ["@kozane/core", "@kozane/client"]) {
    assert.ok(app.dependencies?.[name], `Application must directly depend on ${name}`);
  }
  const core = resolvePackage("@kozane/core", root);
  const client = resolvePackage("@kozane/client", root);
  assert.ok(core && client, "Missing installed core/client package");
  assert.equal(manifest(core).version, expected.core, "Unexpected core version");
  const clientManifest = manifest(client);
  assert.equal(clientManifest.version, expected.client, "Unexpected client version");
  assert.equal(
    clientManifest.peerDependencies?.["@kozane/core"],
    expected.core,
    "Missing/incompatible exact core peer",
  );
  assert.ok(
    !clientManifest.dependencies?.["@kozane/core"],
    "Client must use a core peer, not a runtime dependency",
  );
  const visited = new Set();
  const instances = new Set();
  /** @param {string} directory */
  function visit(directory) {
    if (visited.has(directory)) return;
    visited.add(directory);
    const pkg = manifest(directory);
    if (pkg.name === "@kozane/core") instances.add(directory);
    const required = { ...pkg.dependencies };
    for (const [name, version] of Object.entries(pkg.peerDependencies ?? {})) {
      if (!pkg.peerDependenciesMeta?.[name]?.optional) required[name] = version;
    }
    const optional = pkg.optionalDependencies ?? {};
    for (const name of new Set([...Object.keys(required), ...Object.keys(optional)])) {
      const dependency = resolvePackage(name, directory);
      if (!dependency && Object.hasOwn(optional, name)) continue;
      assert.ok(dependency, `Missing runtime dependency ${name} from ${pkg.name ?? "application"}`);
      visit(dependency);
    }
  }
  visit(root);
  assert.equal(instances.size, 1, "Duplicate core installations in the resolved runtime graph");
  assert.ok(instances.has(core));
  assert.equal(
    resolvePackage("@kozane/core", client),
    core,
    "Application and client resolve different core instances",
  );
  return {
    core,
    client,
    versions: { core: manifest(core).version, client: clientManifest.version },
  };
}
