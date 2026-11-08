import { sql } from "drizzle-orm";
import {
  withReadTx,
  createServiceContext,
  databaseFailureKind,
  type DB,
} from "@kozane/core/database";
import {
  MigrationHistoryError,
  SchemaMismatchError,
  validateDatabaseMigrationHistory,
  validateDatabaseSchema,
} from "@kozane/core/migrations";
import { namespaces, snapshot } from "@kozane/core/services";
import { HarnessFailure, failureKind, type CandidateRequest } from "./recovery";
export type NamespaceView =
  | {
      kind: "selected";
      namespaceId: string;
      snapshot: NonNullable<Awaited<ReturnType<typeof snapshot.get>>>;
    }
  | { kind: "empty" | "selection_required" | "missing" };
/** Complete database checks precede service reads. The worker adapter owns whole-operation serialization. */
export async function validateCandidate(db: DB, request: CandidateRequest): Promise<NamespaceView> {
  try {
    await withReadTx(db, async (tx) => {
      const integrity = await tx.values<unknown[]>(sql`PRAGMA integrity_check`);
      if (integrity.length !== 1 || integrity[0][0] !== "ok")
        throw new HarnessFailure("database_content", "Integrity check failed");
      if ((await tx.values(sql`PRAGMA foreign_key_check`)).length)
        throw new HarnessFailure("database_content", "Foreign-key check failed");
    });
    await validateDatabaseMigrationHistory(db, "complete");
    await validateDatabaseSchema(db);
    const context = createServiceContext();
    const rows = await namespaces.list(db, context);
    if (request.sampleNamespaceId !== undefined) {
      if (
        !rows.some((row) => row.id === request.sampleNamespaceId) ||
        !(await snapshot.get(db, context, request.sampleNamespaceId))
      )
        throw new HarnessFailure("database_content", "Required sample namespace is missing");
    }
    const readView = async (namespaceId?: string): Promise<NamespaceView> => {
      await request.beforeView?.(namespaceId);
      const rows = await namespaces.list(db, context);
      let selected: string | undefined;
      if (namespaceId !== undefined) {
        if (!rows.some((row) => row.id === namespaceId)) return { kind: "missing" };
        selected = namespaceId;
      } else {
        if (!rows.length) return { kind: "empty" };
        const defaults = rows.filter((row) => row.isDefault);
        if (defaults.length === 1) selected = defaults[0].id;
        else if (rows.length === 1) selected = rows[0].id;
        else return { kind: "selection_required" };
      }
      const initial = await snapshot.get(db, context, selected);
      if (!initial)
        throw new HarnessFailure("unknown", "Selected namespace snapshot is unavailable");
      return { kind: "selected", namespaceId: selected, snapshot: initial };
    };
    return request.navigation
      ? await request.navigation.resolve(readView)
      : await readView(request.namespaceId);
  } catch (error) {
    if (
      error instanceof MigrationHistoryError ||
      error instanceof SchemaMismatchError ||
      failureKind(error) === "database_content" ||
      databaseFailureKind(error) === "database_content"
    )
      throw new HarnessFailure("database_content", "Database compatibility check failed");
    throw error;
  }
}
