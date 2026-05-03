import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { getDBURL } from "./internal/config.js";
import * as schema from "./schema.js";

const client = createClient({ url: getDBURL() });
await client.execute("PRAGMA foreign_keys = ON");
export const db = drizzle(client, { schema });

// Canonical DB type for dependency injection in API functions
export type DB = typeof db;

// Transaction handle — LibSQLDatabase minus `batch`, which is unavailable inside transactions
export type Tx = LibSQLDatabase<typeof schema>;

// Union type accepted by all db/api/ functions — works inside or outside a transaction
export type AnyDB = DB | Tx;

export async function withTx<T>(db: DB, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // SQLiteTransaction is a structural subset of LibSQLDatabase (no `batch`);
  // casting fn avoids the incompatible parameter type while keeping db itself typed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.transaction(fn as any);
}
