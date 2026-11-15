import type { DB, Tx } from "./database.js";

const databases = new WeakSet<DB>();
export function registerDatabaseHandle(db: DB): void {
  databases.add(db);
}
/** Internal distinction for compatibility record APIs accepting a DB or an existing Tx. */
export function isDatabaseHandle(handle: DB | Tx): handle is DB {
  return databases.has(handle as DB);
}
