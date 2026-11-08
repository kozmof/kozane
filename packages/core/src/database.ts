import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "./schema.js";

declare const databaseBrand: unique symbol;
declare const transactionBrand: unique symbol;
declare const readTransactionBrand: unique symbol;
export type DatabaseHandle = BaseSQLiteDatabase<"async", unknown, typeof schema>;
export type DB = DatabaseHandle & { readonly [databaseBrand]: true };
export type Tx = DatabaseHandle & { readonly [transactionBrand]: true };
/** Raw SQL readers are trusted and can still execute arbitrary SQL. */
export type ReadHandle = Pick<
  DatabaseHandle,
  "select" | "selectDistinct" | "query" | "all" | "get" | "values"
>;
export type ReadTx = ReadHandle & { readonly [readTransactionBrand]: true };
export type AnyDB = DB | Tx | ReadTx;

export interface MigrationBatchStatement {
  readonly sql: string;
  readonly args: readonly (string | number)[];
}
export type MigrationPreparation = (
  handle: DatabaseHandle,
) => Promise<readonly MigrationBatchStatement[]>;

/**
 * Await commit and cleanup before resolving, and rollback and cleanup before
 * rejecting. Preserve callback errors and reject failed commits. Reads require
 * one consistent snapshot. Serialize operations on shared connections.
 * Never retry callbacks automatically because they may perform external effects.
 */
export interface DatabaseAdapterHooks {
  write<T>(operation: (handle: DatabaseHandle) => Promise<T>): Promise<T>;
  read<T>(operation: (handle: DatabaseHandle) => Promise<T>): Promise<T>;
  /** Prepare outside the batch, then atomically execute with foreign keys disabled. */
  migrate?(prepare: MigrationPreparation): Promise<void>;
}
const adapters = new WeakMap<DB, DatabaseAdapterHooks>();

/** Driver hooks own transaction start, commit and rollback. */
export function createDatabaseAdapter(handle: DatabaseHandle, hooks: DatabaseAdapterHooks): DB {
  if (
    typeof hooks?.write !== "function" ||
    typeof hooks?.read !== "function" ||
    (hooks.migrate !== undefined && typeof hooks.migrate !== "function")
  )
    throw new TypeError(
      "Database adapter requires read/write hooks and an optional migration hook",
    );
  if (adapters.has(handle as DB)) throw new Error("Database handle already has an adapter");
  const db = handle as DB;
  adapters.set(db, hooks);
  return db;
}
function adapter(db: DB): DatabaseAdapterHooks {
  const hooks = adapters.get(db);
  if (!hooks) throw new Error("Database handle needs createDatabaseAdapter");
  return hooks;
}
export function withTx<T>(db: DB, operation: (tx: Tx) => Promise<T>): Promise<T> {
  return adapter(db).write((handle) => operation(handle as Tx));
}
export function withReadTx<T>(db: DB, operation: (tx: ReadTx) => Promise<T>): Promise<T> {
  return adapter(db).read((handle) => operation(handle as unknown as ReadTx));
}
/** Migration batches have a driver-owned boundary distinct from ordinary write transactions. */
export async function withMigration(db: DB, prepare: MigrationPreparation): Promise<void> {
  const hooks = adapter(db);
  if (!hooks.migrate) throw new Error("Database adapter does not support migration batches");
  await hooks.migrate(prepare);
}

export { createServiceContext, type ServiceContext } from "./services/context.js";

export {
  normalizeDatabaseFailure,
  databaseFailureKind,
  type DatabaseFailureKind,
  type DatabaseFailure,
  type DatabaseConstraint,
} from "./failures.js";

/** Resolve adapter references and invoke transaction-bound services on one write handle. */
export function composeWrite<T>(db: DB, operation: (tx: Tx) => Promise<T>): Promise<T> {
  return withTx(db, operation);
}

/**
 * Low-level operations for reference resolution and Node compatibility.
 * These do not provide configured service validation. Prefer resource services
 * for application writes, including inside composeWrite.
 */
export * as records from "./api/index.js";
