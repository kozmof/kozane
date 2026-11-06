import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build } from "vite";
import { builtinModules } from "node:module";
import { createHash } from "node:crypto";
const repository = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "kozane-core-package-"));
function run(command, args, cwd = repository) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (cause) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${cause.stdout ?? ""}\n${cause.stderr ?? ""}`,
      { cause },
    );
  }
}
try {
  run("pnpm", ["--filter", "@kozane/core", "check:migrations"]);
  run("pnpm", ["--filter", "@kozane/core", "pack", "--pack-destination", temporary]);
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
  assert.deepEqual(Object.keys(candidate.dependencies).sort(), ["drizzle-orm", "uuid"]);
  const drizzleVersion = candidate.dependencies["drizzle-orm"];
  const uuidVersion = candidate.dependencies.uuid;
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
  // Reuse locked registry artifacts without importing the workspace's optional
  // driver peers. The adapter fixture also directly declares the same Drizzle version.
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
        version: ${drizzleVersion}
packages:
  ${packageKey}:
    resolution: {integrity: ${integrity}, tarball: ${JSON.stringify(archiveReference)}}
    version: ${candidate.version}
${lockedPackage(`drizzle-orm@${drizzleVersion}`)}
${lockedPackage(`uuid@${uuidVersion}`)}
snapshots:
  ${packageKey}:
    dependencies:
      drizzle-orm: ${drizzleVersion}
      uuid: ${uuidVersion}
  drizzle-orm@${drizzleVersion}: {}
  uuid@${uuidVersion}: {}
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
  writeFileSync(
    join(temporary, "runtime.mjs"),
    `
    import assert from 'node:assert/strict';
    import { ValidationError, domainErrorCode, MigrationHistoryError as RootMigrationHistoryError } from '@kozane/core';
    import { createDatabaseAdapter, withTx, withReadTx, createServiceContext } from '@kozane/core/database';
    import * as schema from '@kozane/core/schema';
    import * as services from '@kozane/core/services';
    import { migrations, schemaVersion, validateMigrationHistory, MigrationHistoryError } from '@kozane/core/migrations';
    import { DatabaseSync } from 'node:sqlite';
    assert.equal(ValidationError, services.ValidationError);
    assert.equal(domainErrorCode(new ValidationError('invalid')), 'validation');
    assert.equal(createServiceContext, services.createServiceContext);
    assert.throws(() => createServiceContext({contentMax: 1}), ValidationError);
    assert.ok(schema.cardTable);
    assert.equal(typeof services.cards.create, 'function');
    const handle = {};
    let writes = 0, reads = 0;
    const db = createDatabaseAdapter(handle, { write: async operation => { writes++; return operation(handle); }, read: async operation => { reads++; return operation(handle); } });
    assert.equal(await withTx(db, async tx => tx), handle);
    assert.equal(await withReadTx(db, async tx => tx), handle);
    assert.equal(writes, 1); assert.equal(reads, 1);
    assert.equal(MigrationHistoryError, RootMigrationHistoryError);
    assert.ok(Object.isFrozen(migrations));
    assert.equal(schemaVersion, migrations.at(-1).id);
    const history = migrations.map(record => ({hash: record.hash, created_at: record.when}));
    assert.equal(validateMigrationHistory(history, 'complete').complete, true);
    assert.throws(() => validateMigrationHistory([{...history[0], hash:'altered'}], 'prefix'), error => error instanceof MigrationHistoryError && error instanceof ValidationError);
    const sqlite = new DatabaseSync(':memory:');
    try {
      sqlite.exec('PRAGMA foreign_keys=OFF; BEGIN DEFERRED');
      for (const record of migrations) for (const statement of record.statements) sqlite.exec(statement);
      sqlite.exec('COMMIT; PRAGMA foreign_keys=ON');
      for (const name of ['namespace', 'scope_area', 'inventory']) assert.ok(sqlite.prepare('SELECT name FROM sqlite_schema WHERE name=?').get(name));
      assert.ok(sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name='card_stamp_missing_timestamps'").get());
    } finally { sqlite.close(); }
    await assert.rejects(import('@kozane/core/dist/src/services/errors.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  `,
  );
  run(process.execPath, [join(temporary, "runtime.mjs")], temporary);
  const referencePath = join(temporary, "reference.sqlite");
  const referenceClient = createClient({ url: `file:${referencePath}` });
  try {
    await migrate(drizzle(referenceClient), { migrationsFolder: join(repository, "drizzle") });
  } finally {
    referenceClient.close();
  }
  writeFileSync(
    join(temporary, "migrations.mjs"),
    readFileSync(join(repository, "scripts/fixtures/core-consumer-migrations.mjs")),
  );
  console.log(
    run(process.execPath, [join(temporary, "migrations.mjs"), referencePath], temporary).trim(),
  );
  writeFileSync(
    join(temporary, "consumer.ts"),
    `
    import type { CardCreateInput, Namespace, ValidationError } from '@kozane/core';
    import { createServiceContext, withTx, withReadTx, type DB } from '@kozane/core/database';
    import { cards, namespaces } from '@kozane/core/services';
    import { cardTable } from '@kozane/core/schema';
    import { migrations, schemaVersion, validateMigrationHistory, applyMigrations, validateDatabaseMigrationHistory, type MigrationRecord } from '@kozane/core/migrations';
    declare const db: DB;
    declare const error: ValidationError;
    const input: CardCreateInput = { partitionId: 'p', content: 'Typed public consumer' };
    const context = createServiceContext();
    void cards.create(db, context, 'n', input);
    void namespaces.list(db, context).then((rows: Namespace[]) => rows);
    void withTx(db, tx => cards.createInTx(tx, context, 'n', input));
    void withReadTx(db, async tx => {
      // @ts-expect-error Read handles cannot enter a write service.
      await cards.createInTx(tx, context, 'n', input);
    });
    // @ts-expect-error Domain input types reject non-string content.
    const invalid: CardCreateInput = { partitionId: 'p', content: 7 };
    void invalid; void error; void cardTable;
    const record: MigrationRecord = migrations[0];
    void record.statements; void schemaVersion;
    void validateMigrationHistory([], 'prefix');
    void applyMigrations(db).then(result => result.appliedIds);
    void validateDatabaseMigrationHistory(db, 'complete');
    // @ts-expect-error Database history checks require an explicit supported mode.
    void validateDatabaseMigrationHistory(db, 'automatic');
    // @ts-expect-error History checks require an explicit supported mode.
    void validateMigrationHistory([], 'automatic');
  `,
  );
  writeFileSync(
    join(temporary, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
      },
      files: ["consumer.ts"],
    }),
  );
  run(
    process.execPath,
    [
      join(repository, "node_modules/typescript/bin/tsc"),
      "--project",
      join(temporary, "tsconfig.json"),
    ],
    temporary,
  );
  const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
  await build({
    configFile: false,
    publicDir: false,
    plugins: [
      {
        name: "packed-core-browser-boundary",
        enforce: "pre",
        resolveId(source) {
          if (
            source.startsWith("node:") ||
            builtins.has(source) ||
            source.startsWith("$") ||
            source.startsWith("@sveltejs/")
          )
            throw new Error(`Core runtime cannot import ${source}`);
        },
      },
    ],
    build: {
      outDir: join(temporary, "browser"),
      emptyOutDir: true,
      lib: {
        entry: Object.fromEntries(
          Object.entries(manifest.exports).map(([key, entry]) => [
            key === "." ? "index" : key.slice(2),
            resolve(installed, entry.import),
          ]),
        ),
        formats: ["es"],
      },
      rollupOptions: {
        external: (id) => id === "uuid" || id === "drizzle-orm" || id.startsWith("drizzle-orm/"),
      },
    },
  });
  console.log(
    "Packed core public runtime, declarations, adapter hooks and browser exports passed in an isolated offline installation.",
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
