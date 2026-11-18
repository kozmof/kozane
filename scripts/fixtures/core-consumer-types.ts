import type {
  CardCreateInput,
  Namespace,
  ValidationError,
  CardPositionUpdate,
  CardData,
  NamespaceDataSnapshot,
  TaskspaceFileTree,
  TaskspaceTruncation,
  TakenCard,
  Footprint,
  SlotPlacement,
  SharedTaskspace,
  ActionInputsV2,
  LocalRecoveryCheckpoint,
  LocalRecoveryCheckpointKey,
} from "@kozane/core";
import {
  planStow,
  squashCardPositions,
  scanTagPositions,
  groupHitRows,
  applyPalette,
  chunked,
  CARD_WIDTH_RANGE,
  byteLength,
  isPlainObject,
  entryNameIssue,
  errorMessage,
  parseLocalRecoveryCheckpoint,
  parseLocalRecoveryCheckpointRecord,
  type BoardRect,
  type CardContentCheck,
  type PathKind,
  type TagPosition,
  type TagHit,
} from "@kozane/core";
import { createServiceContext, withTx, withReadTx, records, type DB } from "@kozane/core/database";
import { cards, namespaces, taskspaces } from "@kozane/core/services";
import {
  captureLocalRecoveryCheckpoint,
  validateStoredLocalRecoveryCheckpoint,
  rememberLocalRecoveryCheckpoint,
  parseLocalRecoveryIdentity,
  type LocalRecoveryIdentity,
  type LocalRecoverySnapshot,
  parseSharedRecoveryProjection,
  validateSharedRecoveryProjection,
  reconstructSharedRecoveryProjection,
  type SharedRecoveryProjection,
  type SharedRecoveryHistory,
  type SharedRecoverySelection,
  type SharedRecoveryEffect,
  describeSharedRecoveryHistory,
  parseSharedRecoveryCheckpoint,
  parseSharedRecoveryHistoryPayload,
  requireSharedRecoveryCheckpoint,
  validateSharedRecoveryCheckpoint,
  type SharedRecoveryCheckpoint,
  type SharedRecoveryHistoryPayload,
  rememberSharedRecoveryCheckpoint,
  inspectSharedRecoveryCheckpoint,
  validateStoredSharedRecoveryCheckpoint,
  type SharedRecoveryCheckpointBinding,
  parseSharedRecoveryHistoryImages,
  sharedRecoveryAssetManifest,
  type SharedRecoveryHistoryImages,
  describeRecoveryAssets,
  parseRecoveryAssetPayload,
  parseRecoveryAssetCheckpoint,
  requireRecoveryAssetCheckpoint,
  type RecoveryAssetPayload,
  type RecoveryAssetCheckpoint,
  parseRecoveryAssetCheckpointRecord,
  rememberRecoveryAssetCheckpoint,
  rememberRecoveryAssetCheckpointInTx,
  readRecoveryAssetCheckpoint,
  inspectRecoveryAssetCheckpoint,
  requireStoredRecoveryAssetCheckpoint,
  describeSharedRecoveryExecutions,
  parseSharedRecoveryExecutionHistory,
  parseSharedRecoveryExecutionCheckpoint,
  requireSharedRecoveryExecutionCheckpoint,
  sharedRecoveryExecutionAssetManifest,
  type SharedRecoveryExecutionSelection,
  type SharedRecoveryExecutionSet,
  type SharedRecoveryExecutionHistory,
  type SharedRecoveryExecutionCheckpoint,
  parseSharedRecoveryExecutionCheckpointRecord,
  rememberSharedRecoveryExecutionCheckpoint,
  rememberSharedRecoveryExecutionCheckpointInTx,
  readSharedRecoveryExecutionCheckpoint,
  inspectSharedRecoveryExecutionCheckpoint,
  requireStoredSharedRecoveryExecutionCheckpoint,
  type SharedRecoveryExecutionCheckpointBinding,
  describeSharedRecoveryActions,
  parseSharedRecoveryActionHistory,
  parseSharedRecoveryActionCheckpoint,
  requireSharedRecoveryActionCheckpoint,
  sharedRecoveryActionAssetManifest,
  type SharedRecoveryActionSelection,
  type SharedRecoveryActionRecord,
  type SharedRecoveryActionHistory,
  type SharedRecoveryActionCheckpoint,
  parseSharedRecoveryActionCheckpointRecord,
  rememberSharedRecoveryActionCheckpoint,
  rememberSharedRecoveryActionCheckpointInTx,
  readSharedRecoveryActionCheckpoint,
  inspectSharedRecoveryActionCheckpoint,
  requireStoredSharedRecoveryActionCheckpoint,
  type SharedRecoveryActionCheckpointBinding,
} from "@kozane/core/recovery";
import { cardTable } from "@kozane/core/schema";
import {
  migrations,
  schemaVersion,
  validateMigrationHistory,
  applyMigrations,
  validateDatabaseMigrationHistory,
  canonicalSchemaManifest,
  compareSchemaManifests,
  validateDatabaseSchema,
  type MigrationRecord,
} from "@kozane/core/migrations";
declare const db: DB;
declare const error: ValidationError;
const input: CardCreateInput = { partitionId: "p", content: "Typed public consumer" };
const position: CardPositionUpdate = { cardId: "c", posX: 1, posY: 2 };
declare const snapshot: NamespaceDataSnapshot;
const card: CardData = snapshot.cards[0];
const trees: Record<string, TaskspaceFileTree> | undefined = snapshot.taskspaceFiles;
// @ts-expect-error Card position coordinates remain numeric.
const invalidPosition: CardPositionUpdate = { cardId: "c", posX: "1", posY: 2 };
// @ts-expect-error Truncation reasons remain a closed union.
const invalidTruncation: TaskspaceTruncation = "complete";
void position;
void card;
void trees;
void invalidPosition;
void invalidTruncation;
const taken: TakenCard = { cardId: "c", position: { posX: 1, posY: 2 } };
const held: Footprint[] = [{ cardId: "c", slot: 0, span: 1 }];
const placements: SlotPlacement[] = planStow(held, [{ cardId: "d", span: 1 }], null);
void squashCardPositions([], 2, { origin: taken.position, canvasWidth: 400 });
// @ts-expect-error Inventory footprint spans remain numeric.
const invalidFootprint: Footprint = { cardId: "c", slot: 0, span: "1" };
void placements;
void invalidFootprint;
const tags: TagPosition[] = scanTagPositions(":tag");
declare const hits: (TagHit & { extra: number })[];
const extra: number = groupHitRows(hits)[0].hits[0].extra;
const partitionExtra: number = applyPalette([{ id: "p", extra: 1 }])[0].extra;
// @ts-expect-error URL/tag source offsets remain numeric.
const invalidTag: TagPosition = { tag: "tag", index: "0", length: 4 };
void tags;
void extra;
void partitionExtra;
void invalidTag;
const rect: BoardRect = { posX: 1, posY: 2, width: 120, height: 120 };
const range: [number, number] = CARD_WIDTH_RANGE;
const pathKind: PathKind = "workspace_relative";
const content: CardContentCheck = { ok: true, content: "ok" };
const chunkValue: number = chunked([{ extra: 1 }], { size: 1 })[0][0].extra;
// @ts-expect-error Board rectangles still require complete dimensions.
const invalidRect: BoardRect = { posX: 1, posY: 2 };
// @ts-expect-error Stored path kinds remain a closed union.
const invalidPathKind: PathKind = "relative";
void rect;
void range;
void pathKind;
void content;
void chunkValue;
void invalidRect;
void invalidPathKind;
declare const unknownValue: unknown;
if (isPlainObject(unknownValue)) {
  const object: Record<string, unknown> = unknownValue;
  void object;
}
const bytes: number = byteLength("日本");
const nameIssue: string | null = entryNameIssue("notes");
const message: string = errorMessage(unknownValue);
// @ts-expect-error Entry validation still requires a string.
void entryNameIssue({});
// @ts-expect-error Byte counts still require text.
void byteLength(1);
void bytes;
void nameIssue;
void message;
const context = createServiceContext();
void withReadTx(db, async (tx) => {
  // @ts-expect-error Read transactions do not expose mutation builders.
  tx.insert(cardTable);
  // @ts-expect-error Read transactions cannot open nested write transactions.
  tx.transaction(async () => {});
  const rows: Namespace[] = await records.namespace.getAllNamespaces({ db: tx });
  // @ts-expect-error Read transactions cannot call table-level writes.
  await records.namespace.addNamespace({ db: tx, name: "invalid" });
  void rows;
});
const batch: records.utils.BatchResult<"foreign-cards", { ids: string[] }> = {
  ok: true,
  ids: ["c"],
};
// @ts-expect-error Table batch reasons remain a closed union.
const invalidBatch: records.utils.BatchResult<"unknown"> = { ok: false, reason: "unknown" };
void batch;
void invalidBatch;
void cards.create(db, context, "n", input);
void namespaces.list(db, context).then((rows: Namespace[]) => rows);
void withTx(db, (tx) => cards.createInTx(tx, context, "n", input));
void withTx(db, async (tx) => {
  const shared: SharedTaskspace = await taskspaces.createInTx(tx, context, "n", {
    name: "Shared label",
    scopeId: "s",
  });
  // @ts-expect-error Shared taskspace service responses exclude device-local attachments.
  void shared.path;
  await taskspaces.renameInTx(tx, context, "n", shared.id, { name: "Renamed" });
  await taskspaces.removeInTx(tx, context, "n", shared.id);
  const envelope: ActionInputsV2["taskspaces.create"] = {
    args: { namespaceId: "n" },
    body: { name: "Shared", scopeId: "s" },
  };
  void envelope;
  const taskspaceId: string = await records.taskspace.addTaskspaceInTx({
    db: tx,
    namespaceId: "n",
    name: "Label",
  });
  await records.taskspace.updateTaskspaceNameInTx({ db: tx, taskspaceId, name: "Renamed" });
  await records.taskspace.updateTaskspaceLocationInTx({
    db: tx,
    taskspaceId,
    path: "local",
    lastSeenAt: new Date(),
  });
  // @ts-expect-error Shared database creation cannot attach a local path.
  await records.taskspace.addTaskspaceInTx({ db: tx, path: "local" });
  await records.taskspace.updateTaskspaceNameInTx({
    db: tx,
    taskspaceId,
    name: "Label",
    // @ts-expect-error A label change cannot also move the local directory.
    path: "local",
  });
  // @ts-expect-error Local observations cannot rename the shared label.
  await records.taskspace.updateTaskspaceLocationInTx({ db: tx, taskspaceId, name: "Label" });
  await records.taskspace.deleteTaskspaceInTx({ db: tx, taskspaceId });
});
// @ts-expect-error Caller-owned taskspace transaction methods require a Tx handle.
void records.taskspace.addTaskspaceInTx({ db, name: "Requires transaction" });
void withReadTx(db, async (tx) => {
  // @ts-expect-error Read handles cannot enter a write service.
  await cards.createInTx(tx, context, "n", input);
});
// @ts-expect-error Domain input types reject non-string content.
const invalid: CardCreateInput = { partitionId: "p", content: 7 };
void invalid;
void error;
void cardTable;
const record: MigrationRecord = migrations[0];
void record.statements;
void schemaVersion;
void validateMigrationHistory([], "prefix");
void applyMigrations(db).then((result) => result.appliedIds);
void validateDatabaseMigrationHistory(db, "complete");
void validateDatabaseSchema(db).then((result) => result.matches);
void compareSchemaManifests(canonicalSchemaManifest);
// @ts-expect-error Canonical manifests are immutable.
canonicalSchemaManifest.push({});
// @ts-expect-error Database history checks require an explicit supported mode.
void validateDatabaseMigrationHistory(db, "automatic");
const checkpoint: LocalRecoveryCheckpoint = {
  version: 1,
  identity: {
    workspaceId: "workspace",
    deviceId: "device",
    epochId: "epoch",
    checkpointId: "checkpoint",
    schemaId: migrations.at(-1)!.id,
  },
  selection: { baselineId: "baseline", effectSetIds: [] },
  byteLength: 642,
  sha256: "a".repeat(64),
};
const checkpointKey: LocalRecoveryCheckpointKey = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
};
void parseLocalRecoveryCheckpoint(checkpoint).sha256;
const parsedIdentity: LocalRecoveryIdentity = parseLocalRecoveryIdentity(checkpoint.identity);
const sharedProjection: SharedRecoveryProjection = parseSharedRecoveryProjection({
  version: 1,
  rowEncodingVersion: 1,
  schemaId: migrations.at(-1)!.id,
  tables: [],
});
void validateSharedRecoveryProjection(async () => db, sharedProjection).then(
  (validated: SharedRecoveryProjection) => validated,
);
const sharedSelection: SharedRecoverySelection = {
  baselineId: "baseline",
  effectSets: [{ id: "empty", effectCount: 0 }],
};
const sharedHistory: SharedRecoveryHistory = {
  baseline: { id: "baseline", projection: sharedProjection },
  effectSets: [{ id: "empty", effects: [] }],
};
const reconstructed: SharedRecoveryProjection = reconstructSharedRecoveryProjection(
  sharedHistory,
  sharedSelection,
);
const sharedEffect: SharedRecoveryEffect = {
  ord: 0,
  table: "namespace",
  key: { id: ["text", "n"] },
  op: "D",
  before: { id: ["text", "n"], name: ["text", "Main"], is_default: ["integer", "0"] },
  after: null,
};
void reconstructed;
void describeSharedRecoveryHistory(sharedHistory, parsedIdentity, sharedSelection).then(
  async ({ payload, checkpoint, projection }) => {
    const savedPayload: SharedRecoveryHistoryPayload = parseSharedRecoveryHistoryPayload(payload);
    const descriptor: SharedRecoveryCheckpoint = parseSharedRecoveryCheckpoint(checkpoint);
    const prepared = await requireSharedRecoveryCheckpoint(
      savedPayload,
      descriptor,
      parsedIdentity,
    );
    const validated = await validateSharedRecoveryCheckpoint(
      async () => db,
      savedPayload,
      descriptor,
      parsedIdentity,
    );
    const target: SharedRecoveryProjection = validated.projection;
    const historyImages: SharedRecoveryHistoryImages = parseSharedRecoveryHistoryImages({
      baseline: { id: "baseline", manifest: { version: 1, entries: [] } },
      effectSets: [{ id: "empty", manifest: { version: 1, entries: [] } }],
    });
    const required = sharedRecoveryAssetManifest(savedPayload, historyImages);
    const executionSelection: SharedRecoveryExecutionSelection = {
      baselineId: "baseline",
      effectSets: [{ id: "empty", rootId: "empty-root", executionCount: 1 }],
    };
    const root = { id: "empty-root", kind: "future.noop", contractVersion: 99, input: {} };
    const executionSet: SharedRecoveryExecutionSet = {
      id: "empty",
      invocation: root,
      generated: {},
      executions: [{ ...root, parentId: null, executionOrd: 0, generated: {} }],
      effects: [],
    };
    void describeSharedRecoveryExecutions({
      checkpoint: descriptor,
      selection: executionSelection,
      sharedHistory: savedPayload,
      effectSets: [executionSet],
    }).then(async ({ payload, checkpoint }) => {
      const history: SharedRecoveryExecutionHistory = parseSharedRecoveryExecutionHistory(payload);
      const expected: SharedRecoveryExecutionCheckpoint =
        parseSharedRecoveryExecutionCheckpoint(checkpoint);
      const result: SharedRecoveryExecutionHistory = await requireSharedRecoveryExecutionCheckpoint(
        history,
        expected,
        parsedIdentity,
        savedPayload,
      );
      void sharedRecoveryExecutionAssetManifest(result, historyImages).entries;
      const originalSelection: SharedRecoveryActionSelection = { actionIds: ["empty-root"] };
      const original: SharedRecoveryActionRecord = {
        ...root,
        rootId: root.id,
        parentId: null,
        generated: {},
        seq: "9007199254740993",
        hlc: "opaque:first-record",
        deviceId: parsedIdentity.deviceId,
        epochId: parsedIdentity.epochId,
        schemaId: parsedIdentity.schemaId,
      };
      const originals = await describeSharedRecoveryActions({
        actions: [original],
        selection: originalSelection,
        checkpoint: expected,
        executions: result,
        sharedHistory: savedPayload,
      });
      const originalPayload: SharedRecoveryActionHistory = parseSharedRecoveryActionHistory(
        originals.payload,
      );
      const originalCheckpoint: SharedRecoveryActionCheckpoint =
        parseSharedRecoveryActionCheckpoint(originals.checkpoint);
      const verifiedOriginals: SharedRecoveryActionHistory =
        await requireSharedRecoveryActionCheckpoint(
          originalPayload,
          originalCheckpoint,
          parsedIdentity,
          result,
          savedPayload,
        );
      void sharedRecoveryActionAssetManifest(verifiedOriginals, { version: 1, entries: [] })
        .entries;
      // @ts-expect-error First-record metadata is immutable.
      verifiedOriginals.actions[0].seq = "1";
      // @ts-expect-error Trusted original action selection is immutable.
      originalCheckpoint.selection.actionIds.push("other");
      const registered = await rememberSharedRecoveryExecutionCheckpoint(db, expected);
      const binding: SharedRecoveryExecutionCheckpointBinding = registered.binding;
      const registeredOriginals = await rememberSharedRecoveryActionCheckpoint(
        db,
        originalCheckpoint,
      );
      const originalBinding: SharedRecoveryActionCheckpointBinding = registeredOriginals.binding;
      void parseSharedRecoveryActionCheckpointRecord(
        checkpointKey,
        JSON.stringify(originalCheckpoint),
        JSON.stringify(originalBinding.localCheckpoint),
      );
      void withTx(db, (tx) => rememberSharedRecoveryActionCheckpointInTx(tx, originalCheckpoint));
      void readSharedRecoveryActionCheckpoint(db, checkpointKey);
      void inspectSharedRecoveryActionCheckpoint(db, checkpointKey);
      const storedOriginals: SharedRecoveryActionHistory =
        await requireStoredSharedRecoveryActionCheckpoint(
          db,
          originalPayload,
          parsedIdentity,
          result,
          savedPayload,
        );
      void storedOriginals.actions;
      void parseSharedRecoveryExecutionCheckpointRecord(
        checkpointKey,
        JSON.stringify(expected),
        JSON.stringify(binding.localCheckpoint),
      );
      void withTx(db, (tx) => rememberSharedRecoveryExecutionCheckpointInTx(tx, expected));
      void readSharedRecoveryExecutionCheckpoint(db, checkpointKey);
      void inspectSharedRecoveryExecutionCheckpoint(db, checkpointKey);
      const stored: SharedRecoveryExecutionHistory =
        await requireStoredSharedRecoveryExecutionCheckpoint(
          db,
          result,
          parsedIdentity,
          savedPayload,
        );
      void stored.effectSets;
      // @ts-expect-error Execution histories are immutable.
      result.effectSets[0].executions.push(root);
      // @ts-expect-error Retained execution counts are immutable.
      expected.selection.effectSets[0].executionCount = 0;
    });
    void required.entries;
    // @ts-expect-error Parsed history manifests are immutable.
    historyImages.effectSets.push({ id: "extra", manifest: { version: 1, entries: [] } });
    const remembered = await rememberSharedRecoveryCheckpoint(db, descriptor);
    const binding: SharedRecoveryCheckpointBinding = remembered.binding;
    void inspectSharedRecoveryCheckpoint(db, checkpointKey);
    void validateStoredSharedRecoveryCheckpoint(db, async () => db, savedPayload, parsedIdentity);
    void binding;
    void projection;
    void prepared;
    void target;
    // @ts-expect-error Shared content descriptors are immutable.
    descriptor.sha256 = "b".repeat(64);
    // @ts-expect-error Shared history payloads are immutable.
    savedPayload.history.effectSets.push({ id: "extra", effects: [] });
  },
);
// @ts-expect-error Reconstruction effects are immutable.
sharedEffect.ord = 1;
// @ts-expect-error Materialization selections are immutable.
sharedSelection.effectSets.push({ id: "extra", effectCount: 0 });
// @ts-expect-error Parsed shared projections are immutable.
sharedProjection.schemaId = "other";
// @ts-expect-error Parsed host identities are immutable.
parsedIdentity.deviceId = "other";
void captureLocalRecoveryCheckpoint(db, checkpoint.identity, async () => checkpoint.selection).then(
  ({ snapshot, checkpoint }) => {
    const captured: LocalRecoverySnapshot = snapshot;
    void rememberLocalRecoveryCheckpoint(db, checkpoint);
    void validateStoredLocalRecoveryCheckpoint(db, async () => db, captured, checkpoint.identity);
    void describeRecoveryAssets({
      localSnapshot: captured,
      sharedHistory,
      binding: { localCheckpoint: checkpoint, checkpoint: {} },
      history: {},
    }).then(async ({ payload, checkpoint: assets }) => {
      const parsed: RecoveryAssetPayload = parseRecoveryAssetPayload(payload);
      const descriptor: RecoveryAssetCheckpoint = parseRecoveryAssetCheckpoint(assets);
      const verified: RecoveryAssetPayload = await requireRecoveryAssetCheckpoint(
        parsed,
        descriptor,
        captured.identity,
        { localSnapshot: captured, sharedHistory },
      );
      void verified.manifest.entries;
      void parseRecoveryAssetCheckpointRecord(checkpointKey, JSON.stringify(descriptor));
      void rememberRecoveryAssetCheckpoint(db, descriptor);
      void withTx(db, (tx) => rememberRecoveryAssetCheckpointInTx(tx, descriptor));
      void readRecoveryAssetCheckpoint(db, checkpointKey);
      void inspectRecoveryAssetCheckpoint(db, checkpointKey);
      const stored: RecoveryAssetPayload = await requireStoredRecoveryAssetCheckpoint(
        db,
        parsed,
        captured.identity,
        { localSnapshot: captured, sharedHistory },
      );
      void stored.manifest;
      // @ts-expect-error Asset descriptors retain immutable checkpoint bindings.
      descriptor.binding.localCheckpoint.sha256 = "b".repeat(64);
      // @ts-expect-error Per-record asset requirements are immutable.
      parsed.history.effectSets.push({ id: "extra", manifest: { version: 1, entries: [] } });
    });
  },
);
void parseLocalRecoveryCheckpointRecord(checkpointKey, JSON.stringify(checkpoint)).identity;
// @ts-expect-error Checkpoint descriptors are immutable.
checkpoint.sha256 = "b".repeat(64);
// @ts-expect-error History checks require an explicit supported mode.
void validateMigrationHistory([], "automatic");
