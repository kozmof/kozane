import assert from "node:assert/strict";
import * as core from "@kozane/core";
import {
  ValidationError,
  domainErrorCode,
  MigrationHistoryError as RootMigrationHistoryError,
  cardSpan,
  planStow,
  splitCardContent,
  squashInventorySlots,
  INVENTORY_COLUMNS,
  normalizeTag,
  tagMatches,
  scanTagPositions,
  scanTagLines,
  buildTagTree,
  scanUrls,
  PALETTE,
  applyPalette,
  compareIds,
} from "@kozane/core";
import {
  createDatabaseAdapter,
  withTx,
  withReadTx,
  createServiceContext,
} from "@kozane/core/database";
import * as schema from "@kozane/core/schema";
import * as services from "@kozane/core/services";
import {
  migrations,
  schemaVersion,
  validateMigrationHistory,
  MigrationHistoryError,
} from "@kozane/core/migrations";
import { DatabaseSync } from "node:sqlite";
assert.equal(ValidationError, services.ValidationError);
assert.equal(domainErrorCode(new ValidationError("invalid")), "validation");
assert.equal(createServiceContext, services.createServiceContext);
assert.throws(() => createServiceContext({ contentMax: 1 }), ValidationError);
assert.ok(schema.cardTable);
assert.equal(typeof services.cards.create, "function");
assert.equal(INVENTORY_COLUMNS, 6);
assert.equal(cardSpan("short"), 1);
assert.deepEqual(
  planStow(
    [],
    [
      { cardId: "a", span: 1 },
      { cardId: "b", span: 1 },
    ],
    null,
  ),
  [
    { cardId: "a", slot: 0 },
    { cardId: "b", slot: 1 },
  ],
);
assert.deepEqual(splitCardContent("one. two。three"), ["one", "two", "three"]);
assert.deepEqual(squashInventorySlots(["one", "two"]), [0, 1]);
assert.equal(normalizeTag("Å"), "å");
assert.equal(tagMatches("FOO", "foo:bar"), true);
assert.equal(tagMatches("foo", "foobar"), false);
assert.deepEqual(
  scanTagPositions("https://example.test/:hidden :visible").map((hit) => hit.tag),
  ["visible"],
);
assert.deepEqual(
  scanTagLines(":Foo:Bar").map((hit) => hit.tag),
  ["foo:bar"],
);
assert.deepEqual(
  buildTagTree([{ tag: "foo:bar", source: { kind: "card", cardId: "c" }, excerpt: "" }])[0].total,
  { cards: 1, files: 0 },
);
assert.deepEqual(scanUrls("https://example.test."), [{ url: "https://example.test", index: 0 }]);
assert.deepEqual(applyPalette([{ id: "p", extra: 1 }]), [{ id: "p", extra: 1, ...PALETTE[0] }]);
assert.equal(compareIds("a", "b"), -1);
assert.equal(core.CONTENT_MAX, 200000);
assert.equal(core.NAME_MAX, 255);
assert.equal(core.BATCH_MAX, 2000);
assert.equal(core.clamp(9, 0, 2), 2);
assert.equal(core.byteLength("a日本"), 7);
assert.equal(core.isPlainObject({}), true);
assert.equal(core.isPlainObject(new Date(0)), true);
assert.equal(core.isPlainObject([]), false);
assert.equal(core.isPlainObject(null), false);
assert.throws(() => services.prepareInput(new Date(0)), core.ValidationError);
assert.equal(core.entryNameIssue("notes"), null);
assert.equal(core.entryNameIssue("../escape"), "Name cannot contain a path separator");
assert.equal(
  core.entryNameIssue(" draft ", "File name"),
  "File name cannot start or end with whitespace",
);
assert.equal(core.errorMessage(new Error("failure")), "failure");
assert.equal(core.errorMessage({ message: "object" }), "[object Object]");
assert.equal(core.errorMessage(Symbol("value")), "Symbol(value)");
assert.equal(core.TASKSPACE_DIR_ENTRIES_MAX, 500);
assert.equal(core.TASKSPACE_FILE_BYTES_MAX, 16 * 1024 * 1024);
assert.equal(core.TASKSPACE_SSG_DEPTH_MAX, 64);
assert.equal(core.taskspaceNameIssue("notes"), null);
assert.equal(
  core.taskspaceNameIssue("../escape"),
  "Taskspace name cannot contain a path separator",
);
assert.deepEqual(core.checkCardContent(" ok ", core.CONTENT_MAX), { ok: true, content: "ok" });
assert.equal(core.contentLimitIssue("xx", 1), "content must be a string under 1 characters");
assert.deepEqual(core.chunked([1, 2, 3], { size: 2 }), [[1, 2], [3]]);
assert.equal(schema.PATH_KINDS, core.PATH_KINDS);
assert.deepEqual(createServiceContext(), {
  contentMax: core.CONTENT_MAX,
  canvasWidth: core.CANVAS_W,
  canvasHeight: core.CANVAS_H,
});
for (const name of [
  "DEFAULT_SERVER_PORT",
  "DEFAULT_SERVER_HOST",
  "DRAG_THRESHOLD",
  "ARROW_KEYS",
  "TAG_SCAN_TOTAL_BYTES_MAX",
])
  assert.equal(
    name in core,
    false,
    "Application settings must not become core domain constants: " + name,
  );
const handle = {
  select() {
    return this;
  },
  selectDistinct() {},
  query: {},
  all() {},
  get() {},
  values() {},
  insert() {},
  update() {},
  delete() {},
  run() {},
};
let writes = 0,
  reads = 0;
const db = createDatabaseAdapter(handle, {
  write: async (operation) => {
    writes++;
    return operation(handle);
  },
  read: async (operation) => {
    reads++;
    return operation(handle);
  },
});
assert.equal(await withTx(db, async (tx) => tx), handle);
await withReadTx(db, async (tx) => {
  assert.notEqual(tx, handle);
  assert.ok(Object.isFrozen(tx));
  assert.equal(tx.select(), handle);
  for (const method of ["insert", "update", "delete", "run", "transaction"])
    assert.equal(method in tx, false);
});
assert.equal(writes, 1);
assert.equal(reads, 1);
assert.equal(MigrationHistoryError, RootMigrationHistoryError);
assert.ok(Object.isFrozen(migrations));
assert.equal(schemaVersion, migrations.at(-1).id);
const history = migrations.map((record) => ({ hash: record.hash, created_at: record.when }));
assert.equal(validateMigrationHistory(history, "complete").complete, true);
assert.throws(
  () => validateMigrationHistory([{ ...history[0], hash: "altered" }], "prefix"),
  (error) => error instanceof MigrationHistoryError && error instanceof ValidationError,
);
const sqlite = new DatabaseSync(":memory:");
try {
  sqlite.exec("PRAGMA foreign_keys=OFF; BEGIN DEFERRED");
  for (const record of migrations)
    for (const statement of record.statements) sqlite.exec(statement);
  sqlite.exec("COMMIT; PRAGMA foreign_keys=ON");
  for (const name of ["namespace", "scope_area", "inventory"])
    assert.ok(sqlite.prepare("SELECT name FROM sqlite_schema WHERE name=?").get(name));
  assert.ok(
    sqlite
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='trigger' AND name='card_stamp_missing_timestamps'",
      )
      .get(),
  );
} finally {
  sqlite.close();
}
await assert.rejects(import("@kozane/core/dist/src/services/errors.js"), {
  code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
});
