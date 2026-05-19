import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { getDBURL } from "./internal/config.js";
import * as schema from "./schema.js";
import type { DB } from "./tx.js";

export type { DB, Tx, AnyDB } from "./tx.js";
export { withTx } from "./tx.js";

let _db: DB | null = null;

export async function getDb(): Promise<DB> {
  if (_db) return _db;
  const client = createClient({ url: getDBURL() });
  await client.execute("PRAGMA foreign_keys = ON");
  _db = drizzle(client, { schema }) as unknown as DB;
  return _db;
}

export function resetDb(): void {
  _db = null;
}
