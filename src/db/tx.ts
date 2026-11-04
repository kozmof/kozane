import { migrate } from "drizzle-orm/libsql/migrator";
import type { Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema.js";
import { createDatabaseAdapter, type DB } from "./database.js";
export { withTx, withReadTx } from "./database.js";
export type { DB, Tx, ReadTx, AnyDB } from "./database.js";

const nodeHandles = new WeakMap<DB, LibSQLDatabase<typeof schema>>();
export function migrateNodeDatabase(db: DB, config: Parameters<typeof migrate>[1]): Promise<void> {
  const handle = nodeHandles.get(db);
  if (!handle) throw new Error("Expected a Node libsql database");
  return migrate(handle, config);
}

/** Preserve libsql immediate writes and deferred snapshot reads. */
export function brandDb(db: LibSQLDatabase<typeof schema> & { $client: Client }): DB {
  const reader = drizzle({ client: readTransactionClient(db.$client), schema });
  const branded = createDatabaseAdapter(db, {
    write: (operation) => db.transaction(operation),
    read: (operation) => reader.transaction(operation),
  });
  nodeHandles.set(branded, db);
  return branded;
}

function readTransactionClient(client: Client): Client {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "transaction") return () => target.transaction("deferred");
      const value: unknown = Reflect.get(target, prop, target);
      // Bind to the real client, whose methods use private fields a proxy cannot reach.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
