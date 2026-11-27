import { parseRunArchiveAssetCheckpointRecord } from "./run-archive-asset-store.js";
import { parseSharedRecoveryRunArchiveCheckpointRecord } from "./shared-recovery-run-archive-store.js";
/** Internal isolated SQL validation. This boundary never installs a live local snapshot. */
import { sql } from "drizzle-orm";
import { withTx, type DB } from "../database.js";
import { canonicalSchemaManifest } from "../generated/schema-manifest.js";
import { compareSchemaManifests } from "../migrations/schema.js";
import { readSchemaManifest } from "../migrations/schema-reader.js";
import { configureActionConnection, verifyActionConnection } from "./connection.js";
import { localTableNames } from "./local-tables.js";
import { localRecoveryAssetManifest } from "./local-recovery-assets.js";
import { inspectLocalRecoveryCheckpoint } from "./local-recovery-store.js";
import { parseSharedRecoveryCheckpointRecord } from "./shared-recovery-store.js";
import { parseRecoveryAssetCheckpointRecord } from "./recovery-asset-store.js";
import { parseSharedRecoveryExecutionCheckpointRecord } from "./shared-recovery-execution-store.js";
import { parseSharedRecoveryActionCheckpointRecord } from "./shared-recovery-action-store.js";
import { parseRetainedRecoveryAssetCheckpointRecord } from "./retained-recovery-asset-store.js";
import { parseSharedRecoveryActionArchiveCheckpointRecord } from "./shared-recovery-action-archive-store.js";
import { parseSharedRecoveryRetainedCheckpointRecord } from "./shared-recovery-retained-store.js";
import {
  requireLocalRecoveryCheckpoint,
  parseLocalRecoveryCheckpointRecord,
} from "./local-recovery-checkpoint.js";
import {
  LocalRecoveryError,
  requireLocalRecoveryIdentity,
  type LocalRecoveryIdentity,
  type LocalRecoverySnapshot,
} from "./local-recovery.js";
import { createRestorationPlan } from "./restoration-plan.js";
import { createRowProjection } from "./projection.js";
import {
  captureRowSql,
  decodeCapturedRow,
  installationInsert,
  type InstallationValue,
} from "./sql-codec.js";

const plan = createRestorationPlan(canonicalSchemaManifest, localTableNames);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Resolve expectations from the trusted source catalog, then refuse changes during preparation. */
export async function validateStoredLocalRecoveryCheckpoint(
  trustedCatalog: DB,
  createDatabase: () => Promise<DB>,
  input: unknown,
  expected: LocalRecoveryIdentity,
): Promise<LocalRecoverySnapshot> {
  // Own identity and row data before the first catalog read can yield.
  const snapshot = requireLocalRecoveryIdentity(input, expected);
  const { workspaceId, deviceId, epochId, checkpointId } = snapshot.identity;
  const key = { workspaceId, deviceId, epochId, checkpointId };
  const checkpoint = await inspectLocalRecoveryCheckpoint(trustedCatalog, key);
  if (!checkpoint)
    throw new LocalRecoveryError("Trusted local recovery checkpoint is not registered");
  const validated = await validateLocalRecoveryCheckpoint(
    createDatabase,
    snapshot,
    checkpoint,
    snapshot.identity,
  );
  const current = await inspectLocalRecoveryCheckpoint(trustedCatalog, key);
  if (!current || JSON.stringify(current) !== JSON.stringify(checkpoint))
    throw new LocalRecoveryError("Trusted local recovery checkpoint changed during validation");
  return validated;
}

/** Verify a separately retained content descriptor and trusted identity before SQL validation. */
export async function validateLocalRecoveryCheckpoint(
  createDatabase: () => Promise<DB>,
  input: unknown,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
): Promise<LocalRecoverySnapshot> {
  const snapshot = requireLocalRecoveryIdentity(input, expected);
  const checked = await requireLocalRecoveryCheckpoint(snapshot, checkpoint);
  return validateLocalRecoverySnapshot(createDatabase, checked, snapshot.identity);
}
function statement(value: InstallationValue) {
  // Only canonical table/column identifiers reach the generator. They contain no question marks.
  const parts = value.sql.split("?");
  if (parts.length !== value.args.length + 1)
    throw new LocalRecoveryError("Invalid local recovery installation statement");
  return sql.join(
    parts.flatMap((part, index) =>
      index === 0 ? [sql.raw(part)] : [sql`${value.args[index - 1]}`, sql.raw(part)],
    ),
    sql``,
  );
}

/** The trusted factory owns a separate empty database and its disposal. No filesystem callbacks run. */
export async function validateLocalRecoverySnapshot(
  createDatabase: () => Promise<DB>,
  input: unknown,
  expected: LocalRecoveryIdentity,
): Promise<LocalRecoverySnapshot> {
  // Copy and reject malformed or mismatched transport before allocating any database.
  const snapshot = requireLocalRecoveryIdentity(input, expected);
  localRecoveryAssetManifest(snapshot);
  for (const table of snapshot.tables)
    if (table.name === "local_recovery_checkpoint")
      for (const row of table.rows) {
        const text = (column: string) => {
          const value = row[column];
          if (value[0] !== "text")
            throw new LocalRecoveryError(`Stored checkpoint requires TEXT: ${column}`);
          return value[1];
        };
        parseLocalRecoveryCheckpointRecord(
          {
            workspaceId: text("workspace_id"),
            deviceId: text("device_id"),
            epochId: text("epoch_id"),
            checkpointId: text("checkpoint_id"),
          },
          text("descriptor"),
        );
      }
  for (const table of snapshot.tables)
    if (table.name === "local_recovery_shared_history")
      for (const row of table.rows) {
        const text = (column: string) => {
          const value = row[column];
          if (value[0] !== "text")
            throw new LocalRecoveryError(`Stored shared checkpoint requires TEXT: ${column}`);
          return value[1];
        };
        parseSharedRecoveryCheckpointRecord(
          {
            workspaceId: text("workspace_id"),
            deviceId: text("device_id"),
            epochId: text("epoch_id"),
            checkpointId: text("checkpoint_id"),
          },
          text("descriptor"),
          text("local_descriptor"),
        );
      }
  for (const table of snapshot.tables)
    if (table.name === "local_recovery_assets")
      for (const row of table.rows) {
        const text = (column: string) => {
          const value = row[column];
          if (value[0] !== "text")
            throw new LocalRecoveryError(`Stored asset checkpoint requires TEXT: ${column}`);
          return value[1];
        };
        parseRecoveryAssetCheckpointRecord(
          {
            workspaceId: text("workspace_id"),
            deviceId: text("device_id"),
            epochId: text("epoch_id"),
            checkpointId: text("checkpoint_id"),
          },
          text("descriptor"),
        );
      }
  for (const table of snapshot.tables)
    if (table.name === "local_recovery_retained_assets")
      for (const row of table.rows) {
        const text = (column: string) => {
          const value = row[column];
          if (value[0] !== "text")
            throw new LocalRecoveryError(`Stored asset checkpoint requires TEXT: ${column}`);
          return value[1];
        };
        parseRetainedRecoveryAssetCheckpointRecord(
          {
            workspaceId: text("workspace_id"),
            deviceId: text("device_id"),
            epochId: text("epoch_id"),
            checkpointId: text("checkpoint_id"),
          },
          text("descriptor"),
        );
      }
  for (const table of snapshot.tables)
    if (table.name === "local_recovery_run_assets")
      for (const row of table.rows) {
        const text = (column: string) => {
          const value = row[column];
          if (value[0] !== "text")
            throw new LocalRecoveryError(`Stored asset checkpoint requires TEXT: ${column}`);
          return value[1];
        };
        parseRunArchiveAssetCheckpointRecord(
          {
            workspaceId: text("workspace_id"),
            deviceId: text("device_id"),
            epochId: text("epoch_id"),
            checkpointId: text("checkpoint_id"),
          },
          text("descriptor"),
        );
      }
  for (const table of snapshot.tables)
    if (table.name === "local_recovery_executions")
      for (const row of table.rows) {
        const text = (column: string) => {
          const value = row[column];
          if (value[0] !== "text")
            throw new LocalRecoveryError(`Stored execution checkpoint requires TEXT: ${column}`);
          return value[1];
        };
        parseSharedRecoveryExecutionCheckpointRecord(
          {
            workspaceId: text("workspace_id"),
            deviceId: text("device_id"),
            epochId: text("epoch_id"),
            checkpointId: text("checkpoint_id"),
          },
          text("descriptor"),
          text("local_descriptor"),
        );
      }
  for (const table of snapshot.tables)
    if (table.name === "local_recovery_actions")
      for (const row of table.rows) {
        const text = (column: string) => {
          const value = row[column];
          if (value[0] !== "text")
            throw new LocalRecoveryError(`Stored action checkpoint requires TEXT: ${column}`);
          return value[1];
        };
        parseSharedRecoveryActionCheckpointRecord(
          {
            workspaceId: text("workspace_id"),
            deviceId: text("device_id"),
            epochId: text("epoch_id"),
            checkpointId: text("checkpoint_id"),
          },
          text("descriptor"),
          text("local_descriptor"),
        );
      }
  for (const table of snapshot.tables)
    if (table.name === "local_recovery_retained_history")
      for (const row of table.rows) {
        const text = (column: string) => {
          const value = row[column];
          if (value[0] !== "text")
            throw new LocalRecoveryError(`Stored retained checkpoint requires TEXT: ${column}`);
          return value[1];
        };
        parseSharedRecoveryRetainedCheckpointRecord(
          {
            workspaceId: text("workspace_id"),
            deviceId: text("device_id"),
            epochId: text("epoch_id"),
            checkpointId: text("checkpoint_id"),
          },
          text("descriptor"),
          text("local_descriptor"),
        );
      }
  for (const table of snapshot.tables)
    if (table.name === "local_recovery_action_archives")
      for (const row of table.rows) {
        const text = (column: string) => {
          const value = row[column];
          if (value[0] !== "text")
            throw new LocalRecoveryError(`Stored archive checkpoint requires TEXT: ${column}`);
          return value[1];
        };
        parseSharedRecoveryActionArchiveCheckpointRecord(
          {
            workspaceId: text("workspace_id"),
            deviceId: text("device_id"),
            epochId: text("epoch_id"),
            checkpointId: text("checkpoint_id"),
          },
          text("descriptor"),
          text("local_descriptor"),
        );
      }
  for (const table of snapshot.tables)
    if (table.name === "local_recovery_run_archives")
      for (const row of table.rows) {
        const text = (column: string) => {
          const value = row[column];
          if (value[0] !== "text")
            throw new LocalRecoveryError(`Stored archive checkpoint requires TEXT: ${column}`);
          return value[1];
        };
        parseSharedRecoveryRunArchiveCheckpointRecord(
          {
            workspaceId: text("workspace_id"),
            deviceId: text("device_id"),
            epochId: text("epoch_id"),
            checkpointId: text("checkpoint_id"),
          },
          text("descriptor"),
          text("local_descriptor"),
        );
      }
  const target = createRowProjection(
    plan.loadOrder,
    snapshot.tables.flatMap((table) => table.rows.map((row) => ({ table: table.name, row }))),
  );
  const db = await createDatabase();
  await withTx(db, async (tx) => {
    const execute = (query: string) => tx.values(sql.raw(query));
    await configureActionConnection(execute);
    const actual = await readSchemaManifest(async (query) =>
      (await execute(query)).map((row) => Array.from(row)),
    );
    if (!compareSchemaManifests(actual).matches)
      throw new LocalRecoveryError("Local recovery validation requires the canonical schema");
    for (const table of canonicalSchemaManifest.filter(
      (entry) => entry.type === "table" && entry.name !== "__drizzle_migrations",
    ))
      if ((await tx.values(sql.raw(`SELECT 1 FROM ${quote(table.name)} LIMIT 1`))).length)
        throw new LocalRecoveryError("Local recovery validation requires an empty database");
    await tx.run(sql`SAVEPOINT local_recovery_validation`);
    try {
      for (const table of plan.loadOrder)
        for (const row of target.rows(table.name))
          await tx.run(statement(installationInsert(table.name, row)));
      if ((await tx.values(sql`PRAGMA foreign_key_check`)).length)
        throw new LocalRecoveryError("Local recovery validation foreign-key check failed");
      for (const table of plan.loadOrder) {
        const loaded = await tx.values(
          sql.raw(`SELECT ${captureRowSql(table.columns)} FROM ${quote(table.name)}`),
        );
        target.verifyInstalledRows(
          table.name,
          loaded.map((row) => {
            if (typeof row[0] !== "string")
              throw new LocalRecoveryError("Local recovery validation did not return a row image");
            return decodeCapturedRow(row[0]);
          }),
        );
      }
      await verifyActionConnection(execute);
    } finally {
      // Successful validation must leave no attachments, intents or pins in the isolated database.
      await tx.run(sql`ROLLBACK TO local_recovery_validation`);
      await tx.run(sql`RELEASE local_recovery_validation`);
    }
  });
  return snapshot;
}
