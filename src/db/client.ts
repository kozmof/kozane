import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { getDBURL } from "./internal/config.js";
import * as schema from "./schema.js";
import type { DB } from "./tx.js";

export type { DB, Tx, AnyDB } from "./tx.js";
export { withTx } from "./tx.js";

export async function createDb(url: string): Promise<DB> {
  const client = createClient({ url });
  await client.execute("PRAGMA foreign_keys = ON");
  return drizzle(client, { schema }) as unknown as DB;
}

let _dbPromise: Promise<DB> | null = null;

export async function getDb(): Promise<DB> {
  if (!_dbPromise) {
    _dbPromise = createDb(getDBURL()).catch((e) => {
      _dbPromise = null;
      throw e;
    });
  }
  return _dbPromise;
}

export function resetDb(): void {
  _dbPromise = null;
}
