import { commitRevision, trackedClient, type CommitRevision } from "./internal/commit-revision.js";
import { runNodeTransaction } from "./internal/transaction.js";
import { UnavailableError } from "../services/errors.js";
import type { DatabaseHandle } from "./database.js";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema.js";
import { createDatabaseAdapter, type DB } from "./database.js";
export { withTx, withReadTx } from "./database.js";
export type { DB, Tx, ReadTx, AnyDB } from "./database.js";

const revisions = new WeakMap<DB, CommitRevision>();
export function nodeCommitRevision(db: DB): Readonly<CommitRevision> {
  const state = revisions.get(db);
  if (!state) throw new Error("Expected Node database");
  return Object.freeze({ ...state });
}

const nodeHandles = new WeakMap<DB, LibSQLDatabase<typeof schema>>();
export function migrateNodeDatabase(db: DB, config: Parameters<typeof migrate>[1]): Promise<void> {
  const handle = nodeHandles.get(db);
  if (!handle) throw new Error("Expected a Node libsql database");
  return migrate(handle, config);
}

/** Preserve libsql immediate writes and deferred snapshot reads. */
export function brandDb(
  original: LibSQLDatabase<typeof schema> & { $client: Client },
  identity?: string,
): DB {
  const state = commitRevision(identity);
  const db = drizzle({ client: trackedClient(original.$client, state), schema });
  let invalid = false;
  const run = <T>(
    mode: "write" | "deferred",
    operation: (handle: DatabaseHandle) => Promise<T>,
  ) => {
    if (invalid) return Promise.reject(new UnavailableError("Database connection is unavailable"));
    return runNodeTransaction(
      async () => {
        const transaction = await db.$client.transaction(mode);
        const client = new Proxy(db.$client, {
          get(target, prop) {
            if (prop === "execute" || prop === "batch") return transaction[prop].bind(transaction);
            const value = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return {
          handle: drizzle({ client, schema }),
          commit: () => transaction.commit(),
          rollback: () => transaction.rollback(),
          close: () => transaction.close(),
        };
      },
      operation,
      () => {
        invalid = true;
        db.$client.close();
      },
    );
  };
  const branded = createDatabaseAdapter(db, {
    write: (operation) => run("write", operation),
    read: (operation) => run("deferred", operation),
  });
  nodeHandles.set(branded, db);
  revisions.set(branded, state);
  return branded;
}
