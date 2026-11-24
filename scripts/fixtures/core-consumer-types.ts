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
  describeSharedRecoveryRetainedHistory,
  parseSharedRecoveryRetainedHistory,
  parseSharedRecoveryRetainedCheckpoint,
  requireSharedRecoveryRetainedCheckpoint,
  validateSharedRecoveryRetainedHistory,
  sharedRecoveryRetainedAssetManifest,
  type SharedRecoveryEffectSetSource,
  type SharedRecoveryRetainedSelection,
  type SharedRecoveryRetainedSet,
  type SharedRecoveryRetainedHistory,
  type SharedRecoveryRetainedCheckpoint,
  type SharedRecoveryRetainedImages,
  parseSharedRecoveryRetainedCheckpointRecord,
  rememberSharedRecoveryRetainedCheckpoint,
  rememberSharedRecoveryRetainedCheckpointInTx,
  readSharedRecoveryRetainedCheckpoint,
  inspectSharedRecoveryRetainedCheckpoint,
  requireStoredSharedRecoveryRetainedCheckpoint,
  type SharedRecoveryRetainedCheckpointBinding,
  parseSharedRecoveryRetainedImages,
  RETAINED_RECOVERY_ASSET_PAYLOAD_VERSION,
  RETAINED_RECOVERY_ASSET_CHECKPOINT_VERSION,
  describeRetainedRecoveryAssets,
  parseRetainedRecoveryAssetPayload,
  parseRetainedRecoveryAssetCheckpoint,
  requireRetainedRecoveryAssetCheckpoint,
  type RetainedRecoveryAssetPayload,
  type RetainedRecoveryAssetCheckpoint,
  type RetainedRecoveryAssetSources,
  parseRetainedRecoveryAssetCheckpointRecord,
  rememberRetainedRecoveryAssetCheckpoint,
  rememberRetainedRecoveryAssetCheckpointInTx,
  readRetainedRecoveryAssetCheckpoint,
  inspectRetainedRecoveryAssetCheckpoint,
  requireStoredRetainedRecoveryAssetCheckpoint,
  SHARED_RECOVERY_ACTION_ARCHIVE_VERSION,
  SHARED_RECOVERY_ACTION_ARCHIVE_CHECKPOINT_VERSION,
  describeSharedRecoveryActionArchive,
  parseSharedRecoveryActionArchive,
  parseSharedRecoveryActionArchiveCheckpoint,
  requireSharedRecoveryActionArchiveCheckpoint,
  sharedRecoveryActionArchiveAssetManifest,
  type SharedRecoveryActionArchiveSelection,
  type SharedRecoveryActionArchive,
  type SharedRecoveryActionArchiveCheckpoint,
  type SharedRecoveryActionArchiveSources,
  rememberSharedRecoveryActionArchiveCheckpoint,
  rememberSharedRecoveryActionArchiveCheckpointInTx,
  readSharedRecoveryActionArchiveCheckpoint,
  inspectSharedRecoveryActionArchiveCheckpoint,
  parseSharedRecoveryActionArchiveCheckpointRecord,
  requireStoredSharedRecoveryActionArchiveCheckpoint,
  type SharedRecoveryActionArchiveCheckpointBinding,
  SHARED_RECOVERY_RUN_ARCHIVE_VERSION,
  SHARED_RECOVERY_RUN_ARCHIVE_CHECKPOINT_VERSION,
  describeSharedRecoveryRunArchive,
  parseSharedRecoveryRunArchive,
  parseSharedRecoveryRunArchiveCheckpoint,
  requireSharedRecoveryRunArchiveCheckpoint,
  validateSharedRecoveryRunArchive,
  sharedRecoveryRunArchiveAssetManifest,
  type SharedRecoveryRunArchive,
  type SharedRecoveryRunArchiveCheckpoint,
  type SharedRecoveryRunArchiveSources,
  inspectPendingRecoveryFileOperations,
  readPendingRecoveryFileOperations,
  type PendingRecoveryFileOperationOptions,
  type PendingRecoveryFileOperationPage,
  parseSharedOnlyRecoveryInstallationRecord,
  readSharedOnlyRecoveryInstallation,
  inspectSharedOnlyRecoveryInstallation,
  checkSharedOnlyRecoveryInstallation,
  installSharedOnlyRecoverySnapshot,
  type SharedOnlyRecoveryInstallation,
  parseSharedRecoveryInstallationRecord,
  readSharedRecoveryInstallation,
  inspectSharedRecoveryInstallation,
  checkSharedRecoveryInstallation,
  installSharedRecoverySnapshot,
  parseLocalRecoveryInstallationRecord,
  readLocalRecoveryInstallation,
  inspectLocalRecoveryInstallation,
  checkLocalRecoveryInstallation,
  installLocalRecoverySnapshot,
  RECOVERY_BUNDLE_INDEX_VERSION,
  RECOVERY_BUNDLE_CHECKPOINT_VERSION,
  describeRecoveryBundleIndex,
  parseRecoveryBundleIndex,
  parseRecoveryBundleCheckpoint,
  requireRecoveryBundleCheckpoint,
  type RecoveryBundleIndex,
  type RecoveryBundleCheckpoint,
  type RecoveryBundleSources,
  type RecoveryBundlePayloadKind,
  type RecoveryBundlePayloadReference,
  RUN_ARCHIVE_ASSET_PAYLOAD_VERSION,
  RUN_ARCHIVE_ASSET_CHECKPOINT_VERSION,
  describeRunArchiveAssets,
  parseRunArchiveAssetPayload,
  parseRunArchiveAssetCheckpoint,
  requireRunArchiveAssetCheckpoint,
  rememberRunArchiveAssetCheckpoint,
  rememberRunArchiveAssetCheckpointInTx,
  readRunArchiveAssetCheckpoint,
  inspectRunArchiveAssetCheckpoint,
  parseRunArchiveAssetCheckpointRecord,
  requireStoredRunArchiveAssetCheckpoint,
  type RunArchiveAssetPayload,
  type RunArchiveAssetCheckpoint,
  type RunArchiveAssetSources,
  rememberSharedRecoveryRunArchiveCheckpoint,
  rememberSharedRecoveryRunArchiveCheckpointInTx,
  readSharedRecoveryRunArchiveCheckpoint,
  inspectSharedRecoveryRunArchiveCheckpoint,
  parseSharedRecoveryRunArchiveCheckpointRecord,
  requireStoredSharedRecoveryRunArchiveCheckpoint,
  type SharedRecoveryRunArchiveCheckpointBinding,
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
declare const retainedAssetLocalSnapshot: LocalRecoverySnapshot;
declare const retainedAssetCurrentPayload: RecoveryAssetPayload;
declare const retainedAssetCurrentCheckpoint: RecoveryAssetCheckpoint;
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
      const archiveVersion: 1 = SHARED_RECOVERY_ACTION_ARCHIVE_VERSION;
      const archiveCheckpointVersion: 1 = SHARED_RECOVERY_ACTION_ARCHIVE_CHECKPOINT_VERSION;
      void archiveVersion;
      void archiveCheckpointVersion;
      const archiveSources: SharedRecoveryActionArchiveSources = {
        originals: verifiedOriginals,
        executions: result,
        sharedHistory: savedPayload,
      };
      const archiveSelection: SharedRecoveryActionArchiveSelection = {
        rootIds: [root.id, "unselected-root"],
        actionIds: [root.id, "unselected-root"],
      };
      const archive = await describeSharedRecoveryActionArchive({
        ...archiveSources,
        checkpoint: originalCheckpoint,
        selection: archiveSelection,
        actions: [
          original,
          {
            ...original,
            id: "unselected-root",
            rootId: "unselected-root",
            seq: "9223372036854775807",
          },
        ],
      });
      const archived: SharedRecoveryActionArchive = parseSharedRecoveryActionArchive(
        archive.payload,
      );
      const archiveCheckpoint: SharedRecoveryActionArchiveCheckpoint =
        parseSharedRecoveryActionArchiveCheckpoint(archive.checkpoint);
      const verifiedArchive: SharedRecoveryActionArchive =
        await requireSharedRecoveryActionArchiveCheckpoint(
          archived,
          archiveCheckpoint,
          parsedIdentity,
          archiveSources,
        );
      void sharedRecoveryActionArchiveAssetManifest(verifiedArchive, { version: 1, entries: [] })
        .entries;
      // @ts-expect-error Archive inventory is immutable.
      archiveCheckpoint.selection.rootIds.push("other");
      // @ts-expect-error First-record archive metadata is immutable.
      verifiedArchive.actions[0].seq = "2";
      void sharedRecoveryActionAssetManifest(verifiedOriginals, { version: 1, entries: [] })
        .entries;
      const source: SharedRecoveryEffectSetSource = "authoritative";
      const retainedSelection: SharedRecoveryRetainedSelection = {
        effectSets: [
          {
            id: "empty",
            rootId: root.id,
            source,
            baselineId: "baseline",
            effectCount: 0,
            executionCount: 1,
          },
        ],
      };
      const retainedSet: SharedRecoveryRetainedSet = {
        id: "empty",
        rootId: root.id,
        source,
        history: savedPayload,
        executions: result,
      };
      const retained = await describeSharedRecoveryRetainedHistory({
        checkpoint: originalCheckpoint,
        selection: retainedSelection,
        effectSets: [retainedSet],
        originals: verifiedOriginals,
        executions: result,
        sharedHistory: savedPayload,
      });
      const retainedPayload: SharedRecoveryRetainedHistory = parseSharedRecoveryRetainedHistory(
        retained.payload,
      );
      const retainedCheckpoint: SharedRecoveryRetainedCheckpoint =
        parseSharedRecoveryRetainedCheckpoint(retained.checkpoint);
      const retainedImages: SharedRecoveryRetainedImages = {
        effectSets: [{ id: "empty", history: historyImages }],
      };
      void sharedRecoveryRetainedAssetManifest(retainedPayload, retainedImages).entries;
      const verifiedRetained: SharedRecoveryRetainedHistory =
        await requireSharedRecoveryRetainedCheckpoint(
          retainedPayload,
          retainedCheckpoint,
          parsedIdentity,
          verifiedOriginals,
          result,
          savedPayload,
        );
      void validateSharedRecoveryRetainedHistory(
        async () => db,
        verifiedRetained,
        retainedCheckpoint,
        parsedIdentity,
        verifiedOriginals,
        result,
        savedPayload,
      );
      const runArchiveVersion: 1 = SHARED_RECOVERY_RUN_ARCHIVE_VERSION;
      const runArchiveCheckpointVersion: 1 = SHARED_RECOVERY_RUN_ARCHIVE_CHECKPOINT_VERSION;
      void runArchiveVersion;
      void runArchiveCheckpointVersion;
      const runArchiveSources: SharedRecoveryRunArchiveSources = {
        ...archiveSources,
        actionArchive: verifiedArchive,
      };
      const runArchive = await describeSharedRecoveryRunArchive({
        ...runArchiveSources,
        checkpoint: archiveCheckpoint,
        selection: retainedSelection,
        effectSets: [retainedSet],
      });
      const runArchivePayload: SharedRecoveryRunArchive = parseSharedRecoveryRunArchive(
        runArchive.payload,
      );
      const runArchiveCheckpoint: SharedRecoveryRunArchiveCheckpoint =
        parseSharedRecoveryRunArchiveCheckpoint(runArchive.checkpoint);
      const verifiedRunArchive: SharedRecoveryRunArchive =
        await requireSharedRecoveryRunArchiveCheckpoint(
          runArchivePayload,
          runArchiveCheckpoint,
          parsedIdentity,
          runArchiveSources,
        );
      void validateSharedRecoveryRunArchive(
        async () => db,
        verifiedRunArchive,
        runArchiveCheckpoint,
        parsedIdentity,
        runArchiveSources,
      );
      void sharedRecoveryRunArchiveAssetManifest(verifiedRunArchive, retainedImages).entries;
      // @ts-expect-error Run archive inventories are immutable.
      runArchiveCheckpoint.selection.effectSets.push(retainedSelection.effectSets[0]);
      // @ts-expect-error Run archive contexts are immutable.
      verifiedRunArchive.effectSets[0].rootId = "other";
      // @ts-expect-error Run archive source payloads include the broader original archive.
      const missingArchiveSource: SharedRecoveryRunArchiveSources = archiveSources;
      void missingArchiveSource;
      // @ts-expect-error Retained provenance has a closed vocabulary.
      const invalidSource: SharedRecoveryEffectSetSource = "future";
      void invalidSource;
      // @ts-expect-error Retained inventory is immutable.
      retainedCheckpoint.selection.effectSets.push(retainedSelection.effectSets[0]);
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
      const registeredArchive = await rememberSharedRecoveryActionArchiveCheckpoint(
        db,
        archiveCheckpoint,
      );
      const archiveBinding: SharedRecoveryActionArchiveCheckpointBinding =
        registeredArchive.binding;
      void parseSharedRecoveryActionArchiveCheckpointRecord(
        checkpointKey,
        JSON.stringify(archiveBinding.checkpoint),
        JSON.stringify(archiveBinding.localCheckpoint),
      );
      void withTx(db, (tx) =>
        rememberSharedRecoveryActionArchiveCheckpointInTx(tx, archiveCheckpoint),
      );
      void readSharedRecoveryActionArchiveCheckpoint(db, checkpointKey);
      void inspectSharedRecoveryActionArchiveCheckpoint(db, checkpointKey);
      const storedArchive: SharedRecoveryActionArchive =
        await requireStoredSharedRecoveryActionArchiveCheckpoint(
          db,
          verifiedArchive,
          parsedIdentity,
          archiveSources,
        );
      void storedArchive.actions;
      const runRegistration = await rememberSharedRecoveryRunArchiveCheckpoint(
        db,
        runArchiveCheckpoint,
      );
      const runBinding: SharedRecoveryRunArchiveCheckpointBinding = runRegistration.binding;
      void parseSharedRecoveryRunArchiveCheckpointRecord(
        checkpointKey,
        JSON.stringify(runBinding.checkpoint),
        JSON.stringify(runBinding.localCheckpoint),
      );
      void withTx(db, (tx) =>
        rememberSharedRecoveryRunArchiveCheckpointInTx(tx, runArchiveCheckpoint),
      );
      void readSharedRecoveryRunArchiveCheckpoint(db, checkpointKey);
      void inspectSharedRecoveryRunArchiveCheckpoint(db, checkpointKey);
      const storedRuns: SharedRecoveryRunArchive =
        await requireStoredSharedRecoveryRunArchiveCheckpoint(
          db,
          verifiedRunArchive,
          parsedIdentity,
          runArchiveSources,
        );
      void storedRuns.effectSets;

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
      const registeredRetained = await rememberSharedRecoveryRetainedCheckpoint(
        db,
        retainedCheckpoint,
      );
      const retainedBinding: SharedRecoveryRetainedCheckpointBinding = registeredRetained.binding;
      const retainedAssetVersion: 1 = RETAINED_RECOVERY_ASSET_PAYLOAD_VERSION;
      const retainedAssetCheckpointVersion: 1 = RETAINED_RECOVERY_ASSET_CHECKPOINT_VERSION;
      void retainedAssetVersion;
      void retainedAssetCheckpointVersion;
      const retainedAssetSources: RetainedRecoveryAssetSources = {
        localSnapshot: retainedAssetLocalSnapshot,
        sharedHistory: savedPayload,
        executions: result,
        originalActions: verifiedOriginals,
        retainedHistory: retainedPayload,
        currentAssets: retainedAssetCurrentPayload,
      };
      const retainedAssets = await describeRetainedRecoveryAssets({
        ...retainedAssetSources,
        binding: retainedBinding,
        assetCheckpoint: retainedAssetCurrentCheckpoint,
        history: parseSharedRecoveryRetainedImages(retainedImages),
        originalImages: { version: 1, entries: [] },
      });
      const retainedAssetPayload: RetainedRecoveryAssetPayload = parseRetainedRecoveryAssetPayload(
        retainedAssets.payload,
      );
      const retainedAssetCheckpoint: RetainedRecoveryAssetCheckpoint =
        parseRetainedRecoveryAssetCheckpoint(retainedAssets.checkpoint);
      const verifiedRetainedAssets: RetainedRecoveryAssetPayload =
        await requireRetainedRecoveryAssetCheckpoint(
          retainedAssetPayload,
          retainedAssetCheckpoint,
          parsedIdentity,
          retainedAssetSources,
        );
      void verifiedRetainedAssets.manifest.entries;
      const runAssetVersion: 1 = RUN_ARCHIVE_ASSET_PAYLOAD_VERSION;
      const runAssetCheckpointVersion: 1 = RUN_ARCHIVE_ASSET_CHECKPOINT_VERSION;
      void runAssetVersion;
      void runAssetCheckpointVersion;
      const runAssetSources: RunArchiveAssetSources = {
        localSnapshot: retainedAssetLocalSnapshot,
        sharedHistory: savedPayload,
        executions: result,
        originalActions: verifiedOriginals,
        actionArchive: verifiedArchive,
        runArchive: runArchivePayload,
        currentAssets: retainedAssetCurrentPayload,
      };
      const runAssets = await describeRunArchiveAssets({
        ...runAssetSources,
        binding: runBinding,
        assetCheckpoint: retainedAssetCurrentCheckpoint,
        history: retainedImages,
        originalImages: { version: 1, entries: [] },
      });
      const runAssetPayload: RunArchiveAssetPayload = parseRunArchiveAssetPayload(
        runAssets.payload,
      );
      const runAssetCheckpoint: RunArchiveAssetCheckpoint = parseRunArchiveAssetCheckpoint(
        runAssets.checkpoint,
      );
      const verifiedRunAssets: RunArchiveAssetPayload = await requireRunArchiveAssetCheckpoint(
        runAssetPayload,
        runAssetCheckpoint,
        parsedIdentity,
        runAssetSources,
      );
      void verifiedRunAssets.manifest.entries;
      const bundleVersion: 1 = RECOVERY_BUNDLE_INDEX_VERSION;
      const bundleCheckpointVersion: 1 = RECOVERY_BUNDLE_CHECKPOINT_VERSION;
      void bundleVersion;
      void bundleCheckpointVersion;
      const bundleSources: RecoveryBundleSources = {
        ...runAssetSources,
        runAssets: verifiedRunAssets,
      };
      const bundle = await describeRecoveryBundleIndex(runAssetCheckpoint, bundleSources);
      const bundleIndex: RecoveryBundleIndex = parseRecoveryBundleIndex(bundle.index);
      const bundleCheckpoint: RecoveryBundleCheckpoint = parseRecoveryBundleCheckpoint(
        bundle.checkpoint,
      );
      const bundleReference: RecoveryBundlePayloadReference = bundleIndex.payloads[0];
      const bundleKind: RecoveryBundlePayloadKind = bundleReference.kind;
      void bundleKind;
      const verifiedBundle: RecoveryBundleIndex = await requireRecoveryBundleCheckpoint(
        bundleIndex,
        bundleCheckpoint,
        parsedIdentity,
        bundleSources,
      );
      void verifiedBundle.manifest;
      const localInstallation = await installLocalRecoverySnapshot(
        db,
        async () => db,
        retainedAssetLocalSnapshot,
        bundleCheckpoint,
        parsedIdentity,
      );
      const localInstallationCheckpoint: RecoveryBundleCheckpoint = localInstallation.checkpoint;
      const localInstallationChanged: boolean = localInstallation.changed;
      void localInstallationChanged;
      void parseLocalRecoveryInstallationRecord(JSON.stringify(localInstallationCheckpoint));
      void readLocalRecoveryInstallation(db);
      void inspectLocalRecoveryInstallation(db);
      void checkLocalRecoveryInstallation(db, bundleCheckpoint, parsedIdentity);
      void withReadTx(db, (tx) => readLocalRecoveryInstallation(tx));
      const sharedInstallation = await installSharedRecoverySnapshot(
        db,
        async () => db,
        savedPayload,
        bundleCheckpoint,
        parsedIdentity,
      );
      const sharedInstallationCheckpoint: RecoveryBundleCheckpoint = sharedInstallation.checkpoint;
      const sharedInstallationChanged: boolean = sharedInstallation.changed;
      void sharedInstallationChanged;
      void parseSharedRecoveryInstallationRecord(JSON.stringify(sharedInstallationCheckpoint));
      void readSharedRecoveryInstallation(db);
      void inspectSharedRecoveryInstallation(db);
      void checkSharedRecoveryInstallation(db, bundleCheckpoint, parsedIdentity);
      void withReadTx(db, (tx) => readSharedRecoveryInstallation(tx));
      // @ts-expect-error Shared installation expectations remain immutable.
      sharedInstallation.checkpoint.sha256 = "changed";
      const pendingOptions: PendingRecoveryFileOperationOptions = { limit: 5, offset: 0 };
      const pendingFiles: PendingRecoveryFileOperationPage =
        await inspectPendingRecoveryFileOperations(
          db,
          bundleCheckpoint,
          parsedIdentity,
          pendingOptions,
        );
      const pendingCount: string = pendingFiles.total;
      const nextPendingOffset: number | null = pendingFiles.nextOffset;
      void pendingCount;
      void nextPendingOffset;
      void withReadTx(db, (tx) =>
        readPendingRecoveryFileOperations(tx, bundleCheckpoint, parsedIdentity, pendingOptions),
      );
      // @ts-expect-error A raw read requires its caller's consistent transaction.
      void readPendingRecoveryFileOperations(db, bundleCheckpoint, parsedIdentity, pendingOptions);
      // @ts-expect-error Pending evidence remains immutable.
      pendingFiles.operations.length = 0;
      const receivingIdentity = { ...parsedIdentity, deviceId: "receiving-device" };
      const sharedOnlyInstallation = await installSharedOnlyRecoverySnapshot(
        db,
        async () => db,
        savedPayload,
        bundleCheckpoint,
        parsedIdentity,
        receivingIdentity,
      );
      const sharedOnlyRecord: SharedOnlyRecoveryInstallation =
        parseSharedOnlyRecoveryInstallationRecord(
          JSON.stringify(sharedOnlyInstallation.checkpoint),
          JSON.stringify(sharedOnlyInstallation.destinationIdentity),
        );
      const sharedOnlyChanged: boolean = sharedOnlyInstallation.changed;
      void sharedOnlyChanged;
      void sharedOnlyRecord;
      void readSharedOnlyRecoveryInstallation(db);
      void inspectSharedOnlyRecoveryInstallation(db);
      void checkSharedOnlyRecoveryInstallation(
        db,
        bundleCheckpoint,
        parsedIdentity,
        receivingIdentity,
      );
      void withReadTx(db, (tx) => readSharedOnlyRecoveryInstallation(tx));
      // @ts-expect-error Receiving identities remain immutable.
      sharedOnlyInstallation.destinationIdentity.deviceId = "Changed";
      // @ts-expect-error Destination installation expectations remain immutable.
      localInstallation.checkpoint.sha256 = "changed";
      // @ts-expect-error A bundle requires its separately verified broader manifest payload.
      const missingBundleManifest: RecoveryBundleSources = runAssetSources;
      void missingBundleManifest;
      // @ts-expect-error Payload references remain immutable.
      bundleIndex.payloads[0].sha256 = "changed";
      // @ts-expect-error The closed payload inventory remains immutable.
      verifiedBundle.payloads.length = 0;
      // @ts-expect-error Original bundle expectations remain immutable.
      bundleCheckpoint.runAssetCheckpoint.sha256 = "changed";
      const registeredRunAssets = await rememberRunArchiveAssetCheckpoint(db, runAssetCheckpoint);
      const storedRunAssetDescriptor: RunArchiveAssetCheckpoint = registeredRunAssets.checkpoint;
      const runAssetsChanged: boolean = registeredRunAssets.changed;
      void runAssetsChanged;
      void parseRunArchiveAssetCheckpointRecord(
        checkpointKey,
        JSON.stringify(storedRunAssetDescriptor),
      );
      void withTx(db, (tx) => rememberRunArchiveAssetCheckpointInTx(tx, storedRunAssetDescriptor));
      void readRunArchiveAssetCheckpoint(db, checkpointKey);
      void inspectRunArchiveAssetCheckpoint(db, checkpointKey);
      const storedRunAssets: RunArchiveAssetPayload = await requireStoredRunArchiveAssetCheckpoint(
        db,
        runAssetPayload,
        parsedIdentity,
        runAssetSources,
      );
      void storedRunAssets.history;
      // @ts-expect-error Broader manifest sources require the original archive and run archive.
      const missingBroaderSources: RunArchiveAssetSources = retainedAssetSources;
      void missingBroaderSources;
      // @ts-expect-error Broader source expectations remain immutable.
      runAssetCheckpoint.binding.localCheckpoint.sha256 = "changed";
      // @ts-expect-error Per-run image requirements remain immutable.
      verifiedRunAssets.history.effectSets.push(retainedImages.effectSets[0]);

      const registeredRetainedAssets = await rememberRetainedRecoveryAssetCheckpoint(
        db,
        retainedAssetCheckpoint,
      );
      const storedRetainedAssetDescriptor: RetainedRecoveryAssetCheckpoint =
        registeredRetainedAssets.checkpoint;
      void parseRetainedRecoveryAssetCheckpointRecord(
        checkpointKey,
        JSON.stringify(storedRetainedAssetDescriptor),
      );
      void withTx(db, (tx) =>
        rememberRetainedRecoveryAssetCheckpointInTx(tx, storedRetainedAssetDescriptor),
      );
      void readRetainedRecoveryAssetCheckpoint(db, checkpointKey);
      void inspectRetainedRecoveryAssetCheckpoint(db, checkpointKey);
      const storedRetainedAssets: RetainedRecoveryAssetPayload =
        await requireStoredRetainedRecoveryAssetCheckpoint(
          db,
          retainedAssetPayload,
          parsedIdentity,
          retainedAssetSources,
        );
      void storedRetainedAssets.history;
      // @ts-expect-error Per-run manifests remain immutable.
      verifiedRetainedAssets.history.effectSets.push(retainedImages.effectSets[0]);
      // @ts-expect-error Original input requirements remain immutable.
      verifiedRetainedAssets.originalImages.entries.length = 0;
      // @ts-expect-error Retained source expectations remain immutable.
      retainedAssetCheckpoint.binding.localCheckpoint.sha256 = "changed";
      void parseSharedRecoveryRetainedCheckpointRecord(
        checkpointKey,
        JSON.stringify(retainedCheckpoint),
        JSON.stringify(retainedBinding.localCheckpoint),
      );
      void withTx(db, (tx) => rememberSharedRecoveryRetainedCheckpointInTx(tx, retainedCheckpoint));
      void readSharedRecoveryRetainedCheckpoint(db, checkpointKey);
      void inspectSharedRecoveryRetainedCheckpoint(db, checkpointKey);
      const storedRetained: SharedRecoveryRetainedHistory =
        await requireStoredSharedRecoveryRetainedCheckpoint(
          db,
          retainedPayload,
          parsedIdentity,
          originalPayload,
          result,
          savedPayload,
        );
      void storedRetained.effectSets;
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
