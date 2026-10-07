import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type * as schema from "./schema.js";

declare const __db: unique symbol;
declare const __tx: unique symbol;

export type DB = LibSQLDatabase<typeof schema> & { readonly [__db]: true };
export type Tx = LibSQLDatabase<typeof schema> & { readonly [__tx]: true };
export type AnyDB = DB | Tx;

/** Drizzle own handle, before either brand is attached. The input to {@link brandDb}. */
type UnbrandedDb = LibSQLDatabase<typeof schema>;

/**
 * Brand a database handle as {@link DB}. Keep this cast in one place because the brand is a
 * compile-time distinction with no runtime property.
 */
export function brandDb(db: UnbrandedDb): DB {
  return db as DB;
}

/** The transaction value drizzle hands its callback, named so the cast below can be narrow. */
type DrizzleTx = Parameters<Parameters<UnbrandedDb["transaction"]>[0]>[0];

export async function withTx<T>(db: DB, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // Restore the transaction's phantom brand on the argument. Keep the callback's generic
  // return type intact.
  return db.transaction((tx: DrizzleTx) => fn(tx as unknown as Tx));
}
