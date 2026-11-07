import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const flag = "--experimental-import-meta-resolve";
if (!process.execArgv.includes(flag)) {
  execFileSync(process.execPath, [flag, ...process.argv.slice(1)], { stdio: "inherit" });
} else {
  const root = resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const expected = pkg.dependencies["@kozane/core"].replace(/^workspace:/, "");
  assert.match(expected, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  const parent = pathToFileURL(join(root, "package.json")).href;
  const coreUrl = import.meta.resolve("@kozane/core", parent);
  const core = await import(coreUrl);
  const database = await import(import.meta.resolve("@kozane/core/database", parent));
  const schema = await import(import.meta.resolve("@kozane/core/schema", parent));
  const services = await import(import.meta.resolve("@kozane/core/services", parent));
  let coreRoot = dirname(fileURLToPath(coreUrl));
  for (;;) {
    try {
      const found = JSON.parse(readFileSync(join(coreRoot, "package.json"), "utf8"));
      if (found.name === "@kozane/core") {
        assert.equal(found.version, expected);
        break;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const next = dirname(coreRoot);
    assert.notEqual(next, coreRoot, "Cannot locate installed core manifest");
    coreRoot = next;
  }
  const legacy = async (path) => import(pathToFileURL(join(root, "dist", path)).href);
  const legacyDb = await legacy("db/database.js");
  const legacySchema = await legacy("db/schema.js");
  const legacyErrors = await legacy("services/errors.js");
  const legacyUtils = await legacy("db/api/utils.js");
  const legacyFailures = await legacy("db/failures.js");
  const legacyServices = await legacy("services/index.js");
  for (const [name, entries] of Object.entries(database.records)) {
    const path = name
      .replace(
        /^(card|composite|inventory)([A-Z])/,
        (_, group, letter) => `${group}/${letter.toLowerCase()}`,
      )
      .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const aliases = await legacy(`db/api/${path}.js`);
    assert.deepEqual(
      Object.keys(aliases).sort(),
      Object.keys(entries).sort(),
      `Node table exports differ: ${name}`,
    );
    for (const [key, value] of Object.entries(aliases))
      assert.equal(value, entries[key], `Node table helper must use public core: ${name}.${key}`);
  }
  for (const path of [
    "lib/inventory.js",
    "lib/squash.js",
    "lib/constants/inventory.js",
    "lib/tag/syntax.js",
    "lib/tag/scan.js",
    "lib/tag/hits.js",
    "lib/tag/tree.js",
    "lib/urls.js",
    "lib/palette.js",
    "lib/order.js",
    "lib/constants/limits.js",
    "lib/constants/domain.js",
    "lib/byte-length.js",
    "lib/plain-object.js",
    "lib/entry-name.js",
    "lib/error-message.js",
  ]) {
    for (const [name, value] of Object.entries(await legacy(path)))
      assert.equal(value, core[name], `Node helper must use public core: ${name}`);
  }
  for (const [path, names] of [
    ["canvas", ["CANVAS_W", "CANVAS_H", "SCOPE_AREA_MIN_SIZE", "clamp", "WARP_HINT_MAX_CHARS"]],
    ["workspace", ["PATH_KINDS", "DEFAULT_LAYER_NAME", "DEFAULT_PARTITION_NAME"]],
    [
      "tag",
      [
        "TAG_SIGIL",
        "TAG_SEGMENT_CHARS_MAX",
        "TAG_LEVELS_MAX",
        "TAG_EXCERPT_CHARS_MAX",
        "TAG_CARD_HITS_MAX",
        "TAG_CARD_ROWS_PAGE",
      ],
    ],
  ]) {
    const aliases = await legacy(`lib/constants/${path}.js`);
    for (const name of names)
      assert.equal(aliases[name], core[name], `Node constant must use public core: ${name}`);
  }
  assert.equal(schema.PATH_KINDS, core.PATH_KINDS);
  for (const name of [
    "cards",
    "glues",
    "layers",
    "partitions",
    "scopes",
    "warps",
    "inventories",
    "namespaces",
    "snapshot",
    "tags",
    "map",
    "warpDirectory",
    "cardBatch",
    "validation",
    "guards",
    "rejection",
  ]) {
    assert.equal(legacyServices[name], services[name]);
    const filename = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const aliases = await legacy(`services/${filename}.js`);
    for (const [key, value] of Object.entries(aliases)) assert.equal(value, services[name][key]);
  }
  assert.equal(
    (await legacy("services/context.js")).createServiceContext,
    database.createServiceContext,
  );
  assert.equal(legacyDb.createDatabaseAdapter, database.createDatabaseAdapter);
  assert.equal(legacyDb.withTx, database.withTx);
  assert.equal(legacyDb.withReadTx, database.withReadTx);
  assert.equal(legacySchema.cardTable, schema.cardTable);
  assert.equal(legacyFailures.normalizeDatabaseFailure, database.normalizeDatabaseFailure);
  for (const name of [
    "ValidationError",
    "ConflictError",
    "LimitError",
    "UnavailableError",
    "NotFoundError",
    "DefaultPartitionError",
    "DefaultLayerError",
  ])
    assert.equal(legacyErrors[name], core[name]);
  for (const name of ["NotFoundError", "DefaultPartitionError", "DefaultLayerError"])
    assert.equal(legacyUtils[name], core[name]);
  const handle = {};
  const db = legacyDb.createDatabaseAdapter(handle, {
    read: (operation) => operation(handle),
    write: (operation) => operation(handle),
  });
  assert.equal(await database.withReadTx(db, async (tx) => tx), handle);
  assert.equal(await legacyDb.withTx(db, async (tx) => tx), handle);
  assert.throws(() => legacyDb.createServiceContext({ contentMax: 0 }), core.ValidationError);
  console.log(
    "Node package uses the expected public core schema, services, adapter state and error instances.",
  );
}
