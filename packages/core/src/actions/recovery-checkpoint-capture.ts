/** Capture matching local rows and complete selected shared history in one read snapshot. */
import { sql } from "drizzle-orm";
import { withReadTx, type DB, type ReadTx } from "../database.js";
import { canonicalSchemaManifest } from "../generated/schema-manifest.js";
import { readSchemaManifest } from "../migrations/schema-reader.js";
import { compareSchemaManifests } from "../migrations/schema.js";
import { validateMigrationHistory } from "../migrations/history.js";
import { fields } from "./recovery-action-data.js";
import {
  readLocalRecoverySnapshot,
  parseLocalRecoveryIdentity,
  type LocalRecoveryIdentity,
  type LocalRecoverySnapshot,
} from "./local-recovery.js";
import {
  describeLocalRecoverySnapshot,
  type LocalRecoveryCheckpoint,
} from "./local-recovery-checkpoint.js";
import {
  describeSharedRecoveryHistory,
  type SharedRecoveryHistoryPayload,
  type SharedRecoveryCheckpoint,
} from "./shared-recovery-checkpoint.js";
import {
  prepareSharedRecoveryHistory,
  verifySharedRecoveryProjection,
  SharedRecoveryError,
  type SharedRecoverySelection,
  type SharedRecoveryProjection,
} from "./shared-recovery.js";

export interface RecoveryCheckpointHistory {
  readonly history: unknown;
  readonly selection: SharedRecoverySelection;
}
export interface CapturedRecoveryCheckpoint {
  readonly local: Readonly<{
    snapshot: LocalRecoverySnapshot;
    checkpoint: LocalRecoveryCheckpoint;
  }>;
  readonly shared: Readonly<{
    payload: SharedRecoveryHistoryPayload;
    projection: SharedRecoveryProjection;
    checkpoint: SharedRecoveryCheckpoint;
  }>;
}
async function requireSourceSchema(tx: ReadTx) {
  if ((await tx.values(sql`SELECT 1 FROM sqlite_temp_schema LIMIT 1`)).length)
    throw new SharedRecoveryError("Checkpoint capture refuses temporary schema objects");
  const actual = await readSchemaManifest(async (query) =>
    (await tx.values(sql.raw(query))).map((row) => Array.from(row)),
  );
  const managed = new Set(
    canonicalSchemaManifest.filter((entry) => entry.type === "table").map((entry) => entry.name),
  );
  if (!compareSchemaManifests(actual.filter((entry) => managed.has(entry.table))).matches)
    throw new SharedRecoveryError("Checkpoint capture requires the canonical managed schema");
  const history = await tx.values(
    sql`SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at`,
  );
  validateMigrationHistory(
    history.map((row) => ({ hash: row[0], created_at: row[1] })),
    "complete",
  );
}
/** The trusted reader obtains completed history, order and counts through the supplied read facade. */
export async function captureRecoveryCheckpoint(
  db: DB,
  identity: LocalRecoveryIdentity,
  readHistory: (tx: ReadTx) => Promise<RecoveryCheckpointHistory>,
): Promise<CapturedRecoveryCheckpoint> {
  const expected = parseLocalRecoveryIdentity(identity);
  if (typeof readHistory !== "function")
    throw new SharedRecoveryError("Checkpoint capture requires a history reader");
  const captured = await withReadTx(db, async (tx) => {
    await requireSourceSchema(tx);
    const input = fields(await readHistory(tx), ["history", "selection"]);
    const shared = prepareSharedRecoveryHistory(
      input.history,
      input.selection as SharedRecoverySelection,
    );
    const local = await readLocalRecoverySnapshot(tx, expected, async () => ({
      baselineId: shared.selection.baselineId,
      effectSetIds: shared.selection.effectSets.map((set) => set.id),
    }));
    await verifySharedRecoveryProjection(tx, shared.projection);
    return { local, shared };
  });
  // Finish adapter commit and cleanup before either content hash begins.
  const [local, shared] = await Promise.all([
    describeLocalRecoverySnapshot(captured.local),
    describeSharedRecoveryHistory(captured.shared.history, expected, captured.shared.selection),
  ]);
  return Object.freeze({ local, shared });
}
