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
  type BoardRect,
  type CardContentCheck,
  type PathKind,
  type TagPosition,
  type TagHit,
} from "@kozane/core";
import { createServiceContext, withTx, withReadTx, records, type DB } from "@kozane/core/database";
import { cards, namespaces } from "@kozane/core/services";
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
// @ts-expect-error History checks require an explicit supported mode.
void validateMigrationHistory([], "automatic");
