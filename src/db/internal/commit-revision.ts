import { randomUUID } from "node:crypto";
import type { Client, InStatement, Transaction } from "@libsql/client";
export interface CommitRevision {
  readonly nonce: string;
  revision: number;
}
const identities = new Map<string, WeakRef<CommitRevision>>();
export function commitRevision(identity?: string): CommitRevision {
  const known = identity ? identities.get(identity)?.deref() : undefined;
  if (known) return known;
  const state = { nonce: randomUUID(), revision: 0 };
  if (identity) identities.set(identity, new WeakRef(state));
  return state;
}
function writes(statement: InStatement): boolean {
  const sql = typeof statement === "string" ? statement : statement.sql;
  const first = sql
    .replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/g, "")
    .match(/^[A-Za-z]+/)?.[0]
    .toUpperCase();
  return first !== undefined && !["SELECT", "EXPLAIN", "VALUES", "PRAGMA"].includes(first);
}
/** Track standalone statements and outer driver commits without counting transaction queries. */
export function trackedClient(client: Client, state: CommitRevision): Client {
  return new Proxy(client, {
    get(target, key) {
      if (key === "execute")
        return async (statement: InStatement) => {
          const result = await target.execute(statement);
          if (writes(statement)) state.revision++;
          return result;
        };
      if (key === "batch")
        return async (statements: InStatement[], mode?: "write" | "read" | "deferred") => {
          const result = await target.batch(statements, mode);
          if (statements.some(writes)) state.revision++;
          return result;
        };
      if (key === "transaction")
        return async (mode?: "write" | "read" | "deferred") => {
          const transaction = await target.transaction(mode);
          let committed = false;
          return new Proxy(transaction, {
            get(tx, prop) {
              if (prop === "commit")
                return async () => {
                  await tx.commit();
                  if (!committed && mode !== "read" && mode !== "deferred") {
                    committed = true;
                    state.revision++;
                  }
                };
              const value = Reflect.get(tx, prop, tx);
              return typeof value === "function" ? value.bind(tx) : value;
            },
          }) as Transaction;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
