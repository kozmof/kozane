import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type * as schema from "./schema.js";

declare const __db: unique symbol;
declare const __tx: unique symbol;

export type DB = LibSQLDatabase<typeof schema> & { readonly [__db]: true };
export type Tx = LibSQLDatabase<typeof schema> & { readonly [__tx]: true };
export type AnyDB = DB | Tx;

export async function withTx<T>(db: DB, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.transaction(fn as any);
}
