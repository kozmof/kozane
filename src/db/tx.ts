import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type * as schema from "./schema.js";

declare const __db: unique symbol;
declare const __tx: unique symbol;

export type DB = LibSQLDatabase<typeof schema> & { readonly [__db]: true };
export type Tx = LibSQLDatabase<typeof schema> & { readonly [__tx]: true };
export type AnyDB = DB | Tx;

/** The transaction value drizzle hands its callback, named so the cast below can be narrow. */
type DrizzleTx = Parameters<Parameters<LibSQLDatabase<typeof schema>["transaction"]>[0]>[0];

export async function withTx<T>(db: DB, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // `Tx` is drizzle's transaction with a phantom brand, so the value below is already the
  // thing `fn` wants and the cast only re-attaches the brand the type system erased.
  //
  // Previously `fn as any`, which also erased `T`: the return type came back as `any` and
  // every caller's result was unchecked from here on. Casting the argument instead keeps
  // `T` flowing out of `fn`. (The disable comment that sat here named an
  // `@typescript-eslint` rule; this project lints with oxlint, so it was never doing
  // anything either.)
  return db.transaction((tx: DrizzleTx) => fn(tx as unknown as Tx));
}
