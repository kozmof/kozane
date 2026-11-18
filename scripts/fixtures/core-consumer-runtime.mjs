import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as core from "@kozane/core";
import * as recovery from "@kozane/core/recovery";
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
assert.equal(recovery.LocalRecoveryError, core.LocalRecoveryError);
assert.equal(recovery.parseLocalRecoveryCheckpoint, core.parseLocalRecoveryCheckpoint);
assert.equal(typeof recovery.validateStoredLocalRecoveryCheckpoint, "function");
assert.equal(typeof recovery.validateSharedRecoveryProjection, "function");
assert.equal(recovery.SHARED_RECOVERY_PROJECTION_VERSION, 1);
const sharedProjection = recovery.parseSharedRecoveryProjection({
  version: 1,
  rowEncodingVersion: 1,
  schemaId: migrations.at(-1).id,
  tables: [
    "namespace",
    "partition",
    "layer",
    "scope",
    "taskspace",
    "inventory",
    "card",
    "glue",
    "glue_rel",
    "scope_rel",
    "scope_area",
    "warp",
  ].map((name) => ({ name, rows: [] })),
});
assert.equal(sharedProjection.tables.length, 12);
assert.ok(Object.isFrozen(sharedProjection.tables[0].rows));
const sharedHistory = {
  baseline: { id: "baseline", projection: sharedProjection },
  effectSets: [{ id: "empty", effects: [] }],
};
const sharedIdentity = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "shared-checkpoint",
  schemaId: migrations.at(-1).id,
};
const sharedSelection = { baselineId: "baseline", effectSets: [{ id: "empty", effectCount: 0 }] };
const sharedDescription = await recovery.describeSharedRecoveryHistory(
  sharedHistory,
  sharedIdentity,
  sharedSelection,
);
assert.equal(sharedDescription.checkpoint.version, recovery.SHARED_RECOVERY_CHECKPOINT_VERSION);
assert.equal(sharedDescription.payload.version, recovery.SHARED_RECOVERY_HISTORY_VERSION);
const emptyExecutionInvocation = {
  id: "empty-root",
  kind: "future.noop",
  contractVersion: 99,
  input: { text: "Preserved 🪁" },
};
const executionDescription = await recovery.describeSharedRecoveryExecutions({
  checkpoint: sharedDescription.checkpoint,
  sharedHistory: sharedDescription.payload,
  selection: {
    baselineId: "baseline",
    effectSets: [{ id: "empty", rootId: "empty-root", executionCount: 1 }],
  },
  effectSets: [
    {
      id: "empty",
      invocation: emptyExecutionInvocation,
      generated: {},
      executions: [{ ...emptyExecutionInvocation, parentId: null, executionOrd: 0, generated: {} }],
      effects: [],
    },
  ],
});
assert.equal(executionDescription.payload.version, recovery.SHARED_RECOVERY_EXECUTIONS_VERSION);
assert.equal(
  executionDescription.checkpoint.version,
  recovery.SHARED_RECOVERY_EXECUTION_CHECKPOINT_VERSION,
);
assert.equal(
  executionDescription.checkpoint.sha256,
  createHash("sha256").update(JSON.stringify(executionDescription.payload), "utf8").digest("hex"),
);
assert.equal(
  executionDescription.checkpoint.byteLength,
  Buffer.byteLength(JSON.stringify(executionDescription.payload), "utf8"),
);
assert.deepEqual(
  recovery.parseSharedRecoveryExecutionHistory(executionDescription.payload),
  executionDescription.payload,
);
assert.deepEqual(
  recovery.parseSharedRecoveryExecutionCheckpoint(executionDescription.checkpoint),
  executionDescription.checkpoint,
);
assert.deepEqual(
  await recovery.requireSharedRecoveryExecutionCheckpoint(
    executionDescription.payload,
    executionDescription.checkpoint,
    sharedIdentity,
    sharedDescription.payload,
  ),
  executionDescription.payload,
);
await assert.rejects(
  recovery.requireSharedRecoveryExecutionCheckpoint(
    executionDescription.payload,
    { ...executionDescription.checkpoint, sha256: "b".repeat(64) },
    sharedIdentity,
    sharedDescription.payload,
  ),
  recovery.SharedRecoveryError,
);
const actionDescription = await recovery.describeSharedRecoveryActions({
  checkpoint: executionDescription.checkpoint,
  selection: { actionIds: ["empty-root"] },
  actions: [
    {
      ...emptyExecutionInvocation,
      rootId: "empty-root",
      parentId: null,
      generated: {},
      seq: "9007199254740993",
      hlc: "opaque:first-record",
      deviceId: "first-record-device",
      epochId: sharedIdentity.epochId,
      schemaId: sharedIdentity.schemaId,
    },
  ],
  executions: executionDescription.payload,
  sharedHistory: sharedDescription.payload,
});
assert.equal(actionDescription.payload.version, recovery.SHARED_RECOVERY_ACTIONS_VERSION);
assert.equal(
  actionDescription.checkpoint.version,
  recovery.SHARED_RECOVERY_ACTION_CHECKPOINT_VERSION,
);
assert.equal(actionDescription.payload.actions[0].seq, "9007199254740993");
assert.equal(
  actionDescription.checkpoint.byteLength,
  Buffer.byteLength(JSON.stringify(actionDescription.payload), "utf8"),
);
assert.equal(
  actionDescription.checkpoint.sha256,
  createHash("sha256").update(JSON.stringify(actionDescription.payload), "utf8").digest("hex"),
);
assert.deepEqual(
  recovery.parseSharedRecoveryActionHistory(actionDescription.payload),
  actionDescription.payload,
);
assert.deepEqual(
  recovery.parseSharedRecoveryActionCheckpoint(actionDescription.checkpoint),
  actionDescription.checkpoint,
);
assert.deepEqual(
  await recovery.requireSharedRecoveryActionCheckpoint(
    actionDescription.payload,
    actionDescription.checkpoint,
    sharedIdentity,
    executionDescription.payload,
    sharedDescription.payload,
  ),
  actionDescription.payload,
);
await assert.rejects(
  recovery.requireSharedRecoveryActionCheckpoint(
    actionDescription.payload,
    { ...actionDescription.checkpoint, sha256: "b".repeat(64) },
    sharedIdentity,
    executionDescription.payload,
    sharedDescription.payload,
  ),
  recovery.SharedRecoveryError,
);
assert.deepEqual(
  recovery.sharedRecoveryActionAssetManifest(actionDescription.payload, {
    version: 1,
    entries: [],
  }),
  { version: 1, entries: [] },
);
const sharedHistoryImages = {
  baseline: { id: "baseline", manifest: { version: 1, entries: [] } },
  effectSets: [{ id: "empty", manifest: { version: 1, entries: [] } }],
};
const retainedDescription = await recovery.describeSharedRecoveryRetainedHistory({
  checkpoint: actionDescription.checkpoint,
  selection: {
    effectSets: [
      {
        id: "empty",
        rootId: "empty-root",
        source: "authoritative",
        baselineId: "baseline",
        effectCount: 0,
        executionCount: 1,
      },
    ],
  },
  effectSets: [
    {
      id: "empty",
      rootId: "empty-root",
      source: "authoritative",
      history: sharedDescription.payload,
      executions: executionDescription.payload,
    },
  ],
  originals: actionDescription.payload,
  executions: executionDescription.payload,
  sharedHistory: sharedDescription.payload,
});
assert.equal(
  retainedDescription.payload.version,
  recovery.SHARED_RECOVERY_RETAINED_HISTORY_VERSION,
);
assert.equal(
  retainedDescription.checkpoint.version,
  recovery.SHARED_RECOVERY_RETAINED_CHECKPOINT_VERSION,
);
assert.equal(
  retainedDescription.checkpoint.byteLength,
  Buffer.byteLength(JSON.stringify(retainedDescription.payload), "utf8"),
);
assert.equal(
  retainedDescription.checkpoint.sha256,
  createHash("sha256").update(JSON.stringify(retainedDescription.payload), "utf8").digest("hex"),
);
assert.deepEqual(
  recovery.parseSharedRecoveryRetainedHistory(retainedDescription.payload),
  retainedDescription.payload,
);
assert.deepEqual(
  recovery.parseSharedRecoveryRetainedCheckpoint(retainedDescription.checkpoint),
  retainedDescription.checkpoint,
);
assert.deepEqual(
  await recovery.requireSharedRecoveryRetainedCheckpoint(
    retainedDescription.payload,
    retainedDescription.checkpoint,
    sharedIdentity,
    actionDescription.payload,
    executionDescription.payload,
    sharedDescription.payload,
  ),
  retainedDescription.payload,
);
await assert.rejects(
  recovery.requireSharedRecoveryRetainedCheckpoint(
    retainedDescription.payload,
    { ...retainedDescription.checkpoint, sha256: "b".repeat(64) },
    sharedIdentity,
    actionDescription.payload,
    executionDescription.payload,
    sharedDescription.payload,
  ),
  recovery.SharedRecoveryError,
);
assert.deepEqual(
  recovery.sharedRecoveryRetainedAssetManifest(retainedDescription.payload, {
    effectSets: [{ id: "empty", history: sharedHistoryImages }],
  }),
  { version: 1, entries: [] },
);
assert.equal(typeof recovery.validateSharedRecoveryRetainedHistory, "function");
assert.deepEqual(
  recovery.sharedRecoveryExecutionAssetManifest(executionDescription.payload, sharedHistoryImages),
  { version: 1, entries: [] },
);
assert.deepEqual(
  recovery.parseSharedRecoveryHistoryImages(sharedHistoryImages),
  sharedHistoryImages,
);
assert.deepEqual(
  recovery.sharedRecoveryAssetManifest(sharedDescription.payload, sharedHistoryImages),
  { version: 1, entries: [] },
);
assert.throws(
  () =>
    recovery.sharedRecoveryAssetManifest(sharedDescription.payload, {
      ...sharedHistoryImages,
      effectSets: [],
    }),
  recovery.SharedRecoveryError,
);
const sharedLocalDescriptor = {
  version: 1,
  identity: sharedIdentity,
  selection: {
    baselineId: sharedSelection.baselineId,
    effectSetIds: sharedSelection.effectSets.map(({ id }) => id),
  },
  byteLength: 697,
  sha256: "a".repeat(64),
};
const assetLocal = await recovery.describeLocalRecoverySnapshot({
  version: 1,
  rowEncodingVersion: 1,
  identity: sharedIdentity,
  selection: sharedLocalDescriptor.selection,
  tables: [
    "taskspace_local",
    "local_file_operation",
    "local_image_upload",
    "local_asset_manifest",
    "local_recovery_checkpoint",
    "local_recovery_shared_history",
    "local_recovery_assets",
    "local_recovery_executions",
    "local_recovery_actions",
  ].map((name) => ({ name, rows: [] })),
});
const assetSources = {
  localSnapshot: assetLocal.snapshot,
  sharedHistory: sharedDescription.payload,
};
const assets = await recovery.describeRecoveryAssets({
  ...assetSources,
  binding: { checkpoint: sharedDescription.checkpoint, localCheckpoint: assetLocal.checkpoint },
  history: sharedHistoryImages,
});
assert.equal(assets.payload.version, recovery.RECOVERY_ASSET_PAYLOAD_VERSION);
assert.equal(assets.checkpoint.version, recovery.RECOVERY_ASSET_CHECKPOINT_VERSION);
assert.equal(
  assets.checkpoint.sha256,
  createHash("sha256").update(JSON.stringify(assets.payload), "utf8").digest("hex"),
);
assert.equal(
  assets.checkpoint.byteLength,
  Buffer.byteLength(JSON.stringify(assets.payload), "utf8"),
);
assert.deepEqual(recovery.parseRecoveryAssetPayload(assets.payload), assets.payload);
assert.deepEqual(recovery.parseRecoveryAssetCheckpoint(assets.checkpoint), assets.checkpoint);
assert.deepEqual(
  recovery.parseSharedRecoveryExecutionCheckpointRecord(
    {
      workspaceId: sharedIdentity.workspaceId,
      deviceId: sharedIdentity.deviceId,
      epochId: sharedIdentity.epochId,
      checkpointId: sharedIdentity.checkpointId,
    },
    JSON.stringify(executionDescription.checkpoint),
    JSON.stringify(assetLocal.checkpoint),
  ),
  { checkpoint: executionDescription.checkpoint, localCheckpoint: assetLocal.checkpoint },
);
for (const helper of [
  recovery.rememberSharedRecoveryExecutionCheckpoint,
  recovery.rememberSharedRecoveryExecutionCheckpointInTx,
  recovery.readSharedRecoveryExecutionCheckpoint,
  recovery.inspectSharedRecoveryExecutionCheckpoint,
  recovery.requireStoredSharedRecoveryExecutionCheckpoint,
])
  assert.equal(typeof helper, "function");
assert.deepEqual(
  recovery.parseSharedRecoveryActionCheckpointRecord(
    {
      workspaceId: sharedIdentity.workspaceId,
      deviceId: sharedIdentity.deviceId,
      epochId: sharedIdentity.epochId,
      checkpointId: sharedIdentity.checkpointId,
    },
    JSON.stringify(actionDescription.checkpoint),
    JSON.stringify(sharedLocalDescriptor),
  ),
  {
    checkpoint: actionDescription.checkpoint,
    localCheckpoint: sharedLocalDescriptor,
  },
);
for (const helper of [
  recovery.rememberSharedRecoveryActionCheckpoint,
  recovery.rememberSharedRecoveryActionCheckpointInTx,
  recovery.readSharedRecoveryActionCheckpoint,
  recovery.inspectSharedRecoveryActionCheckpoint,
  recovery.requireStoredSharedRecoveryActionCheckpoint,
])
  assert.equal(typeof helper, "function");
assert.deepEqual(
  recovery.parseRecoveryAssetCheckpointRecord(
    {
      workspaceId: sharedIdentity.workspaceId,
      deviceId: sharedIdentity.deviceId,
      epochId: sharedIdentity.epochId,
      checkpointId: sharedIdentity.checkpointId,
    },
    JSON.stringify(assets.checkpoint),
  ),
  assets.checkpoint,
);
for (const helper of [
  recovery.rememberRecoveryAssetCheckpoint,
  recovery.rememberRecoveryAssetCheckpointInTx,
  recovery.readRecoveryAssetCheckpoint,
  recovery.inspectRecoveryAssetCheckpoint,
  recovery.requireStoredRecoveryAssetCheckpoint,
])
  assert.equal(typeof helper, "function");
assert.deepEqual(
  await recovery.requireRecoveryAssetCheckpoint(
    assets.payload,
    assets.checkpoint,
    sharedIdentity,
    assetSources,
  ),
  assets.payload,
);
await assert.rejects(
  recovery.requireRecoveryAssetCheckpoint(
    assets.payload,
    { ...assets.checkpoint, sha256: "b".repeat(64) },
    sharedIdentity,
    assetSources,
  ),
  recovery.SharedRecoveryError,
);
assert.deepEqual(
  recovery.parseSharedRecoveryCheckpointRecord(
    {
      workspaceId: sharedIdentity.workspaceId,
      deviceId: sharedIdentity.deviceId,
      epochId: sharedIdentity.epochId,
      checkpointId: sharedIdentity.checkpointId,
    },
    JSON.stringify(sharedDescription.checkpoint),
    JSON.stringify(sharedLocalDescriptor),
  ),
  { checkpoint: sharedDescription.checkpoint, localCheckpoint: sharedLocalDescriptor },
);
assert.deepEqual(
  recovery.parseSharedRecoveryCheckpoint(sharedDescription.checkpoint),
  sharedDescription.checkpoint,
);
assert.deepEqual(
  recovery.parseSharedRecoveryHistoryPayload(sharedDescription.payload),
  sharedDescription.payload,
);
assert.deepEqual(
  await recovery.requireSharedRecoveryCheckpoint(
    sharedDescription.payload,
    sharedDescription.checkpoint,
    sharedIdentity,
  ),
  { payload: sharedDescription.payload, projection: sharedProjection },
);
await assert.rejects(
  recovery.requireSharedRecoveryCheckpoint(
    sharedDescription.payload,
    { ...sharedDescription.checkpoint, sha256: "b".repeat(64) },
    sharedIdentity,
  ),
  recovery.SharedRecoveryError,
);
assert.deepEqual(
  recovery.reconstructSharedRecoveryProjection(sharedHistory, {
    baselineId: "baseline",
    effectSets: [{ id: "empty", effectCount: 0 }],
  }),
  sharedProjection,
);
assert.throws(
  () =>
    recovery.reconstructSharedRecoveryProjection(sharedHistory, {
      baselineId: "baseline",
      effectSets: [{ id: "empty", effectCount: 1 }],
    }),
  recovery.SharedRecoveryError,
);
assert.throws(
  () =>
    recovery.parseSharedRecoveryProjection({
      version: 1,
      rowEncodingVersion: 1,
      schemaId: "unknown",
      tables: [],
    }),
  recovery.SharedRecoveryError,
);
assert.equal(domainErrorCode(new ValidationError("invalid")), "validation");
assert.equal(createServiceContext, services.createServiceContext);
assert.throws(() => createServiceContext({ contentMax: 1 }), ValidationError);
assert.ok(schema.cardTable);
assert.equal(typeof services.cards.create, "function");
const checkpointKey = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
};
const checkpoint = {
  version: core.LOCAL_RECOVERY_CHECKPOINT_VERSION,
  identity: { ...checkpointKey, schemaId: migrations.at(-1).id },
  selection: { baselineId: "baseline", effectSetIds: [] },
  byteLength: 642,
  sha256: "a".repeat(64),
};
assert.deepEqual(core.parseLocalRecoveryCheckpoint(checkpoint), checkpoint);
assert.deepEqual(recovery.parseLocalRecoveryIdentity(checkpoint.identity), checkpoint.identity);
assert.throws(
  () => recovery.parseLocalRecoveryIdentity({ ...checkpoint.identity, schemaId: "unknown" }),
  core.LocalRecoveryError,
);
assert.deepEqual(
  core.parseLocalRecoveryCheckpointRecord(checkpointKey, JSON.stringify(checkpoint)),
  checkpoint,
);
assert.throws(
  () =>
    core.parseLocalRecoveryCheckpointRecord(
      { ...checkpointKey, checkpointId: "other" },
      JSON.stringify(checkpoint),
    ),
  core.LocalRecoveryError,
);
assert.ok(Object.isFrozen(core.parseLocalRecoveryCheckpoint(checkpoint).identity));
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
await withTx(db, async (tx) => {
  assert.notEqual(tx, handle);
  assert.equal(tx.select(), handle);
});
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
  for (const name of [
    "namespace",
    "scope_area",
    "inventory",
    "local_recovery_checkpoint",
    "local_recovery_shared_history",
    "local_recovery_assets",
    "local_recovery_executions",
    "local_recovery_actions",
  ])
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
