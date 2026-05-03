import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type * as schema from "./schema.js";

export type DB = LibSQLDatabase<typeof schema>;
export type Tx = LibSQLDatabase<typeof schema>;
export type AnyDB = DB | Tx;

export async function withTx<T>(db: DB, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.transaction(fn as any);
}
