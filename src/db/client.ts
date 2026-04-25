import { drizzle } from "drizzle-orm/libsql";
import { getDBURL } from "./internal/config.js";
import * as schema from "./schema";

export const db = drizzle(getDBURL(), { schema });

// Canonical DB type for dependency injection in API functions
export type DB = typeof db;

export async function withTx<T>(db: DB, fn: (tx: DB) => Promise<T>): Promise<T> {
  // SQLiteTransaction lacks `batch` vs LibSQLDatabase but supports all CRUD ops inside a tx;
  // the cast is safe and the outer return annotation keeps callers fully typed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (db as any).transaction(fn);
}
