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
    "Node package uses the expected public core schema, adapter state and error instances.",
  );
}
