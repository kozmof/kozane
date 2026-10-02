import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type * as schema from "./schema.js";

declare const __db: unique symbol;
declare const __tx: unique symbol;

export type DB = LibSQLDatabase<typeof schema> & { readonly [__db]: true };
export type Tx = LibSQLDatabase<typeof schema> & { readonly [__tx]: true };
export type AnyDB = DB | Tx;

/** Drizzle own handle, before either brand is attached. The input to {@link brandDb}. */
type UnbrandedDb = LibSQLDatabase<typeof schema>;

/**
 * Mints a {@link DB}, which is the only way a branded handle is allowed to come into
 * existence.
 *
 * The brand is a phantom property no runtime value carries, so attaching it is a cast and
 * can only ever be a cast. What matters is that there is one of them and that it has a
 * name: `openDb` used to write `db as unknown as DB` inline — the single unannotated cast
 * in a module where every other one carries its reasoning — and the whole guarantee that a
 * caller holding a `DB` is not holding a transaction rested on that line being read
 * correctly by whoever touched it next.
 *
 * A function instead, so that a second place reaching for the brand has to come through
 * here, and so that `grep brandDb` answers "where do branded handles come from" rather
 * than asking a reader to recognise a cast as the answer.
 */
export function brandDb(db: UnbrandedDb): DB {
  return db as DB;
}

/** The transaction value drizzle hands its callback, named so the cast below can be narrow. */
type DrizzleTx = Parameters<Parameters<UnbrandedDb["transaction"]>[0]>[0];

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
