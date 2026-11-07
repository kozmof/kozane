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
const corpusScenarios =
  process.argv
    .find((value) => value.startsWith("--corpus-scenarios="))
    ?.slice("--corpus-scenarios=".length) ?? "basic";
assert.ok(["basic", "boundaries"].includes(corpusScenarios), "Unsupported corpus scenarios");
const corpusDriver =
  process.argv
    .find((value) => value.startsWith("--corpus-driver="))
    ?.slice("--corpus-driver=".length) ?? "wasm";
assert.ok(["wasm", "libsql"].includes(corpusDriver), "Unsupported corpus producer driver");
const repository = resolve(import.meta.dirname, "..");
const { checkCorpusRetention } = await import("./compatibility/retention.mjs");
checkCorpusRetention(repository);
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
  run(process.execPath, ["packages/core/scripts/generate-schema.mjs", "--check"]);
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
  const { lockedDriver } = await import("./compatibility/locked-driver.mjs");
  const driverGraph = lockedDriver(
    readFileSync(join(repository, "pnpm-lock.yaml"), "utf8"),
    `@libsql/client@${libsqlVersion}`,
  );
  const client = process.argv.includes("--client-package")
    ? (await import("./client-package/prepare.mjs")).prepareClientConsumer({
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
  const publicTypes = readFileSync(resolve(installed, manifest.exports["."].types), "utf8");
  // Each fresh process must initialize the public entry without a prior root import.
  for (const entry of ["@kozane/core/database", "@kozane/core/services", "@kozane/core/schema"])
    run(
      process.execPath,
      ["--input-type=module", "--eval", `await import(${JSON.stringify(entry)})`],
      temporary,
    );
  for (const path of [
    "inventory",
    "squash",
    "constants/inventory",
    "tag/syntax",
    "tag/scan",
    "tag/hits",
    "tag/tree",
    "urls",
    "palette",
    "order",
    "constants/limits",
    "constants/domain",
  ]) {
    assert.ok(
      entries.has(`package/dist/packages/core/src/${path}.js`),
      `Missing owned helper: ${path}`,
    );
    if (!entries.has(`package/dist/src/lib/${path}.js`)) continue;
    const compatibility = readFileSync(join(installed, "dist/src/lib", `${path}.js`), "utf8");
    assert.match(
      compatibility,
      /^export \{[\w\s,]*\} from "@kozane\/core";\s*$/,
      `Core must own helper implementation: ${path}`,
    );
  }
  for (const topic of ["canvas", "workspace", "tag"])
    assert.ok(
      entries.has(`package/dist/packages/core/src/constants/${topic}.js`),
      `Missing owned constants: ${topic}`,
    );
  for (const name of ["database-types", "types"]) {
    assert.ok(publicTypes.includes(`"./${name}.js"`), `Missing owned ${name} export`);
    const declaration = readFileSync(
      join(installed, "dist/packages/core/src", `${name}.d.ts`),
      "utf8",
    );
    assert.ok(
      !declaration.includes("/src/"),
      `Domain declarations must use core-owned types: ${name}`,
    );
  }
  writeFileSync(
    join(temporary, "runtime.mjs"),
    `
    import assert from 'node:assert/strict';
    import * as core from '@kozane/core';
    import { ValidationError, domainErrorCode, MigrationHistoryError as RootMigrationHistoryError, cardSpan, planStow, splitCardContent, squashInventorySlots, INVENTORY_COLUMNS, normalizeTag, tagMatches, scanTagPositions, scanTagLines, buildTagTree, scanUrls, PALETTE, applyPalette, compareIds } from '@kozane/core';
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
    assert.equal(INVENTORY_COLUMNS, 6);
    assert.equal(cardSpan('short'), 1);
    assert.deepEqual(planStow([], [{cardId:'a', span:1}, {cardId:'b', span:1}], null), [{cardId:'a',slot:0}, {cardId:'b',slot:1}]);
    assert.deepEqual(splitCardContent('one. two。three'), ['one', 'two', 'three']);
    assert.deepEqual(squashInventorySlots(['one', 'two']), [0, 1]);
    assert.equal(normalizeTag('A\u030A'), 'å');
    assert.equal(tagMatches('FOO', 'foo:bar'), true);
    assert.equal(tagMatches('foo', 'foobar'), false);
    assert.deepEqual(scanTagPositions('https://example.test/:hidden :visible').map(hit => hit.tag), ['visible']);
    assert.deepEqual(scanTagLines(':Foo:Bar').map(hit => hit.tag), ['foo:bar']);
    assert.deepEqual(buildTagTree([{tag:'foo:bar', source:{kind:'card',cardId:'c'},excerpt:''}])[0].total, {cards:1,files:0});
    assert.deepEqual(scanUrls('https://example.test.'), [{url:'https://example.test',index:0}]);
    assert.deepEqual(applyPalette([{id:'p',extra:1}]), [{id:'p',extra:1,...PALETTE[0]}]);
    assert.equal(compareIds('a', 'b'), -1);
    assert.equal(core.CONTENT_MAX, 200000);
    assert.equal(core.NAME_MAX, 255);
    assert.equal(core.BATCH_MAX, 2000);
    assert.equal(core.clamp(9,0,2), 2);
    assert.deepEqual(core.checkCardContent(' ok ',core.CONTENT_MAX), {ok:true,content:'ok'});
    assert.equal(core.contentLimitIssue('xx',1), 'content must be a string under 1 characters');
    assert.deepEqual(core.chunked([1,2,3],{size:2}), [[1,2],[3]]);
    assert.equal(schema.PATH_KINDS, core.PATH_KINDS);
    assert.deepEqual(createServiceContext(), {contentMax:core.CONTENT_MAX,canvasWidth:core.CANVAS_W,canvasHeight:core.CANVAS_H});
    for (const name of ['DEFAULT_SERVER_PORT','DEFAULT_SERVER_HOST','DRAG_THRESHOLD','ARROW_KEYS','TAG_SCAN_TOTAL_BYTES_MAX'])
      assert.equal(name in core, false, 'Application settings must not become core domain constants: '+name);
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
    join(temporary, "schema.mjs"),
    readFileSync(join(repository, "scripts/fixtures/core-consumer-schema.mjs")),
  );
  console.log(run(process.execPath, [join(temporary, "schema.mjs")], temporary).trim());
  writeFileSync(
    join(temporary, "consumer.ts"),
    `
    import type { CardCreateInput, Namespace, ValidationError, CardPositionUpdate, CardData, NamespaceDataSnapshot, TaskspaceFileTree, TaskspaceTruncation, TakenCard, Footprint, SlotPlacement } from '@kozane/core';
    import { planStow, squashCardPositions, scanTagPositions, groupHitRows, applyPalette, chunked, CARD_WIDTH_RANGE, type BoardRect, type CardContentCheck, type PathKind, type TagPosition, type TagHit } from '@kozane/core';
    import { createServiceContext, withTx, withReadTx, records, type DB } from '@kozane/core/database';
    import { cards, namespaces } from '@kozane/core/services';
    import { cardTable } from '@kozane/core/schema';
    import { migrations, schemaVersion, validateMigrationHistory, applyMigrations, validateDatabaseMigrationHistory, canonicalSchemaManifest, compareSchemaManifests, validateDatabaseSchema, type MigrationRecord } from '@kozane/core/migrations';
    declare const db: DB;
    declare const error: ValidationError;
    const input: CardCreateInput = { partitionId: 'p', content: 'Typed public consumer' };
    const position: CardPositionUpdate = { cardId: 'c', posX: 1, posY: 2 };
    declare const snapshot: NamespaceDataSnapshot;
    const card: CardData = snapshot.cards[0];
    const trees: Record<string, TaskspaceFileTree> | undefined = snapshot.taskspaceFiles;
    // @ts-expect-error Card position coordinates remain numeric.
    const invalidPosition: CardPositionUpdate = { cardId: 'c', posX: '1', posY: 2 };
    // @ts-expect-error Truncation reasons remain a closed union.
    const invalidTruncation: TaskspaceTruncation = 'complete';
    void position; void card; void trees; void invalidPosition; void invalidTruncation;
    const taken: TakenCard = {cardId:'c', position:{posX:1,posY:2}};
    const held: Footprint[] = [{cardId:'c',slot:0,span:1}];
    const placements: SlotPlacement[] = planStow(held, [{cardId:'d',span:1}], null);
    void squashCardPositions([], 2, {origin:taken.position,canvasWidth:400});
    // @ts-expect-error Inventory footprint spans remain numeric.
    const invalidFootprint: Footprint = {cardId:'c',slot:0,span:'1'};
    void placements; void invalidFootprint;
    const tags: TagPosition[] = scanTagPositions(':tag');
    declare const hits: (TagHit & {extra:number})[];
    const extra: number = groupHitRows(hits)[0].hits[0].extra;
    const partitionExtra: number = applyPalette([{id:'p',extra:1}])[0].extra;
    // @ts-expect-error URL/tag source offsets remain numeric.
    const invalidTag: TagPosition = {tag:'tag',index:'0',length:4};
    void tags; void extra; void partitionExtra; void invalidTag;
    const rect: BoardRect = {posX:1,posY:2,width:120,height:120};
    const range: [number,number] = CARD_WIDTH_RANGE;
    const pathKind: PathKind = 'workspace_relative';
    const content: CardContentCheck = {ok:true,content:'ok'};
    const chunkValue: number = chunked([{extra:1}],{size:1})[0][0].extra;
    // @ts-expect-error Board rectangles still require complete dimensions.
    const invalidRect: BoardRect = {posX:1,posY:2};
    // @ts-expect-error Stored path kinds remain a closed union.
    const invalidPathKind: PathKind = 'relative';
    void rect; void range; void pathKind; void content; void chunkValue; void invalidRect; void invalidPathKind;
    const context = createServiceContext();
    void withReadTx(db, async tx => {
      const rows: Namespace[] = await records.namespace.getAllNamespaces({db:tx});
      // @ts-expect-error Read transactions cannot call table-level writes.
      await records.namespace.addNamespace({db:tx,name:'invalid'});
      void rows;
    });
    const batch: records.utils.BatchResult<'foreign-cards', {ids:string[]}> = {ok:true,ids:['c']};
    // @ts-expect-error Table batch reasons remain a closed union.
    const invalidBatch: records.utils.BatchResult<'unknown'> = {ok:false,reason:'unknown'};
    void batch; void invalidBatch;
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
    void validateDatabaseSchema(db).then(result => result.matches);
    void compareSchemaManifests(canonicalSchemaManifest);
    // @ts-expect-error Canonical manifests are immutable.
    canonicalSchemaManifest.push({});
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
  writeFileSync(
    join(temporary, "drivers.mjs"),
    readFileSync(join(repository, "scripts/fixtures/core-consumer-drivers.mjs")),
  );
  console.log(run(process.execPath, [join(temporary, "drivers.mjs")], temporary).trim());
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
  const corpusOption = process.argv.find((value) => value.startsWith("--bootstrap-corpus="));
  if (corpusOption) {
    const { bootstrapCorpus } = await import("./compatibility/bootstrap.mjs");
    await bootstrapCorpus({
      consumer: temporary,
      archive: join(temporary, archive),
      candidate,
      driver: corpusDriver,
      scenarios: corpusScenarios,
      id: corpusOption.slice("--bootstrap-corpus=".length),
      run,
      repository,
    });
  }
  {
    const { checkCorpus } = await import("./compatibility/check.mjs");
    checkCorpus({
      consumer: temporary,
      repository,
      run,
      client: process.argv.includes("--client-package"),
    });
  }
  if (process.argv.includes("--client-package")) {
    const { checkClientPackage } = await import("./client-package/check.mjs");
    await checkClientPackage({
      consumer: temporary,
      run,
      manifest: client.manifest,
      browserOutput: process.argv.includes("--client-browser-harness")
        ? resolve("tmp/client-package-harness")
        : undefined,
    });
  }
  if (process.argv.includes("--restoration-harness")) {
    const { buildRestorationHarness } = await import("./restoration-harness/build.mjs");
    await buildRestorationHarness(temporary);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
