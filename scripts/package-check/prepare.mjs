import assert from "node:assert/strict";
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { archiveName } from "../release-artifacts.mjs";
export async function prepareCoreConsumer({
  repository,
  temporary,
  run,
  clientPackage,
  artifacts,
}) {
  if (artifacts) {
    const pkg = JSON.parse(readFileSync(join(repository, "packages/core/package.json"), "utf8"));
    copyFileSync(join(artifacts, archiveName(pkg)), join(temporary, archiveName(pkg)));
  } else run("pnpm", ["--filter", "@kozane/core", "pack", "--pack-destination", temporary]);
  const archive = readdirSync(temporary).find((name) => name.endsWith(".tgz"));
  assert.ok(archive, "Missing core tarball");
  const candidate = JSON.parse(
    run("tar", ["-xOf", join(temporary, archive), "package/package.json"]),
  );
  const entries = new Set(
    run("tar", ["-tzf", join(temporary, archive)])
      .trim()
      .split("\n"),
  );
  assert.ok(entries.has("package/LICENCE"));
  assert.ok(entries.has("package/README.md"));
  assert.ok(
    [...entries].every((path) => !path.startsWith("package/dist/src/")),
    "Core must not compile application compatibility modules",
  );
  assert.ok(
    [...entries].every(
      (path) => !path.endsWith("/ui-config.js") && !path.endsWith("/ui-config.d.ts"),
    ),
    "Core must not ship presentation configuration",
  );
  assert.deepEqual(Object.keys(candidate.dependencies).sort(), ["drizzle-orm", "uuid"]);
  const drizzleVersion = candidate.dependencies["drizzle-orm"];
  const uuidVersion = candidate.dependencies.uuid;
  const libsqlVersion = JSON.parse(
    readFileSync(join(repository, "node_modules/@libsql/client/package.json"), "utf8"),
  ).version;
  const drizzleReference = `${drizzleVersion}(@libsql/client@${libsqlVersion})`;
  const wasmVersion = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"))
    .dependencies["@sqlite.org/sqlite-wasm"];
  for (const version of [drizzleVersion, uuidVersion])
    assert.match(
      version,
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
      "Core runtime dependencies must pin the tested version",
    );
  writeFileSync(
    join(temporary, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@kozane/core": `file:${join(temporary, archive)}`,
        "drizzle-orm": drizzleVersion,
        "@sqlite.org/sqlite-wasm": wasmVersion,
        "@libsql/client": libsqlVersion,
      },
    }),
  );
  const store = dirname(run("pnpm", ["store", "path"]).trim());
  const archiveReference = `file:${join(temporary, archive)}`;
  const packageKey = JSON.stringify(`@kozane/core@${archiveReference}`);
  const integrity =
    "sha512-" +
    createHash("sha512")
      .update(readFileSync(join(temporary, archive)))
      .digest("base64");
  // Reuse locked registry artifacts and the tested native driver graph.
  // Adapter fixtures declare their drivers without adding them to core runtime dependencies.
  const registry = readFileSync(join(repository, "pnpm-lock.yaml"), "utf8")
    .split("\npackages:\n")[1]
    .split("\nsnapshots:\n")[0];
  function lockedPackage(name) {
    const block = registry
      .split(/\n(?= {2}\S)/)
      .find((entry) => entry.replace(/^\n/, "").startsWith(`  ${name}:\n`));
    assert.ok(block, `Missing locked artifact ${name}`);
    return block.replace(/^\n/, "").trimEnd();
  }
  const { lockedDriver } = await import("../compatibility/locked-driver.mjs");
  const driverGraph = lockedDriver(
    readFileSync(join(repository, "pnpm-lock.yaml"), "utf8"),
    `@libsql/client@${libsqlVersion}`,
  );
  const client = clientPackage
    ? (await import("../client-package/prepare.mjs")).prepareClientConsumer({
        artifacts,
        consumer: temporary,
        repository,
        run,
        coreReference: archiveReference,
        coreVersion: candidate.version,
      })
    : { importer: "", packages: "", snapshots: "" };
  writeFileSync(
    join(temporary, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .:
    dependencies:
      '@kozane/core':
        specifier: ${JSON.stringify(archiveReference)}
        version: ${JSON.stringify(archiveReference)}
      drizzle-orm:
        specifier: ${drizzleVersion}
        version: ${drizzleReference}
      '@sqlite.org/sqlite-wasm':
        specifier: ${wasmVersion}
        version: ${wasmVersion}
      '@libsql/client':
        specifier: ${libsqlVersion}
        version: ${libsqlVersion}
${client.importer}packages:
  ${packageKey}:
    resolution: {integrity: ${integrity}, tarball: ${JSON.stringify(archiveReference)}}
    version: ${candidate.version}
${lockedPackage(`drizzle-orm@${drizzleVersion}`)}
${driverGraph.packages}
${client.packages}
${lockedPackage(`uuid@${uuidVersion}`)}
${lockedPackage(`'@sqlite.org/sqlite-wasm@${wasmVersion}'`)}
snapshots:
  ${packageKey}:
    dependencies:
      drizzle-orm: ${drizzleReference}
      uuid: ${uuidVersion}
  ${JSON.stringify(`drizzle-orm@${drizzleReference}`)}:
    dependencies:
      '@libsql/client': ${libsqlVersion}
${driverGraph.snapshots}
${client.snapshots}
  uuid@${uuidVersion}: {}
  '@sqlite.org/sqlite-wasm@${wasmVersion}': {}
`,
  );
  run(
    "pnpm",
    [
      "install",
      "--frozen-lockfile",
      "--offline",
      "--ignore-scripts",
      "--ignore-workspace",
      "--store-dir",
      store,
    ],
    temporary,
  );
  const installed = join(temporary, "node_modules/@kozane/core");
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["drizzle-orm", "uuid"]);
  assert.equal(manifest.version, candidate.version);
  assert.deepEqual(manifest.dependencies, candidate.dependencies);
  assert.equal(manifest.publishConfig.access, "public");
  for (const entry of Object.values(manifest.exports)) {
    assert.ok(readFileSync(resolve(installed, entry.import), "utf8").length > 0);
    assert.ok(readFileSync(resolve(installed, entry.types), "utf8").length > 0);
  }
  return { archive, candidate, entries, client, installed, manifest };
}
