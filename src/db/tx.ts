import type { Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

declare const __db: unique symbol;
declare const __tx: unique symbol;
declare const __readTx: unique symbol;

export type DB = LibSQLDatabase<typeof schema> & { readonly [__db]: true };
export type Tx = LibSQLDatabase<typeof schema> & { readonly [__tx]: true };
/**
 * Handle inside a read transaction from {@link withReadTx}. Its own brand keeps it from
 * satisfying `NeedsTx`, so write helpers that require a transaction cannot receive it.
 */
export type ReadTx = LibSQLDatabase<typeof schema> & { readonly [__readTx]: true };
export type AnyDB = DB | Tx | ReadTx;

/** Unbranded Drizzle handle, as `drizzle()` returns it with its libsql client. */
type UnbrandedDb = LibSQLDatabase<typeof schema>;

/** One read handle per database handle, sharing its client and connections. */
const readHandles = new WeakMap<DB, UnbrandedDb>();

/**
 * Brand a database handle as {@link DB}, and prepare the handle {@link withReadTx} uses. Keep
 * this cast in one place because the brand is a compile-time distinction with no runtime
 * property.
 */
export function brandDb(db: UnbrandedDb & { $client: Client }): DB {
  const branded = db as unknown as DB;
  readHandles.set(branded, drizzle({ client: readTransactionClient(db.$client), schema }));
  return branded;
}

/** Drizzle transaction callback value used to keep the cast below narrowly typed. */
type DrizzleTx = Parameters<Parameters<UnbrandedDb["transaction"]>[0]>[0];

/**
 * Run `fn` in a write transaction. libsql starts it with `BEGIN IMMEDIATE`, so it holds the
 * database's write lock from the start. Use {@link withReadTx} for reads.
 */
export async function withTx<T>(db: DB, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // Restore the transaction's phantom brand on the argument. Keep the callback's generic
  // return type intact.
  return db.transaction((tx: DrizzleTx) => fn(tx as unknown as Tx));
}

/**
 * The same client, except that `transaction()` opens a deferred transaction, which takes no
 * lock until its first read and then only a shared one. Drizzle's `transaction()` ignores its
 * config and calls libsql's with no mode, which defaults to `"write"`. libsql's `"read"` mode
 * behaves the same as deferred on a local file, so name the SQLite behavior directly.
 */
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

/**
 * Run `fn` in a transaction meant only for reads. It sees one consistent snapshot without
 * taking the write lock, so other writers (CLI commands, other tabs) are not blocked while it
 * reads. SQLite does not refuse a write here: it would try to take the write lock midway and
 * may fail with `SQLITE_BUSY`. The {@link ReadTx} brand keeps write helpers out instead.
 */
export async function withReadTx<T>(db: DB, fn: (tx: ReadTx) => Promise<T>): Promise<T> {
  const reader = readHandles.get(db);
  if (!reader) throw new Error("withReadTx needs a database handle created by brandDb");
  return reader.transaction((tx: DrizzleTx) => fn(tx as unknown as ReadTx));
}
