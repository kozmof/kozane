/** Local catalog of trusted descriptors. Registration does not publish bundles or retain files. */
import { and, eq, sql } from "drizzle-orm";
import { withReadTx, withTx, type DB, type ReadTx, type Tx } from "../database.js";
import { localRecoveryCheckpointTable as table } from "../schema.js";
import { LocalRecoveryError } from "./local-recovery.js";
import {
  parseLocalRecoveryCheckpoint,
  parseLocalRecoveryCheckpointKey,
  parseLocalRecoveryCheckpointRecord,
  type LocalRecoveryCheckpointKey,
} from "./local-recovery-checkpoint.js";

function where(key: LocalRecoveryCheckpointKey) {
  return and(
    eq(table.workspaceId, key.workspaceId),
    eq(table.deviceId, key.deviceId),
    eq(table.epochId, key.epochId),
    eq(table.checkpointId, key.checkpointId),
  );
}
/** Read metadata without converting its timestamp through JavaScript dates. */
export async function readLocalRecoveryCheckpoint(
  db: DB | Tx | ReadTx,
  input: LocalRecoveryCheckpointKey,
) {
  const key = parseLocalRecoveryCheckpointKey(input);
  const row = await db.select({ descriptor: table.descriptor }).from(table).where(where(key)).get();
  return row ? parseLocalRecoveryCheckpointRecord(key, row.descriptor) : null;
}

/** Only trusted host capture should register its expected descriptor. */
export async function rememberLocalRecoveryCheckpointInTx(tx: Tx, input: unknown) {
  const checkpoint = parseLocalRecoveryCheckpoint(input);
  const { workspaceId, deviceId, epochId, checkpointId } = checkpoint.identity;
  const key = { workspaceId, deviceId, epochId, checkpointId };
  await tx.run(sql`UPDATE local_recovery_checkpoint SET descriptor=descriptor WHERE 0`);
  const existing = await readLocalRecoveryCheckpoint(tx, key);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(checkpoint))
      throw new LocalRecoveryError("Checkpoint identity already has different contents");
    return { checkpoint: existing, changed: false };
  }
  await tx.insert(table).values({
    ...key,
    descriptor: JSON.stringify(checkpoint),
    createdAt: new Date(Math.floor(Date.now() / 1000) * 1000),
  });
  return { checkpoint, changed: true };
}
export function rememberLocalRecoveryCheckpoint(db: DB, input: unknown) {
  const checkpoint = parseLocalRecoveryCheckpoint(input);
  return withTx(db, (tx) => rememberLocalRecoveryCheckpointInTx(tx, checkpoint));
}
export function inspectLocalRecoveryCheckpoint(db: DB, input: LocalRecoveryCheckpointKey) {
  const key = parseLocalRecoveryCheckpointKey(input);
  return withReadTx(db, (tx) => readLocalRecoveryCheckpoint(tx, key));
}
