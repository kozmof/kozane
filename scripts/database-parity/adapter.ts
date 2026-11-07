import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "@kozane/core/schema";
import { createDatabaseAdapter, type DatabaseHandle } from "@kozane/core/database";
import { applyMigrations } from "@kozane/core/migrations";

export type Execute = (sql: string, args?: unknown[]) => Promise<unknown[][]>;
export async function createWasmDatabase(execute: Execute) {
  await execute("PRAGMA foreign_keys=ON");
  const handle = drizzle(
    async (sql, args, method) => {
      const rows = await execute(sql, args);
      return { rows: method === "get" ? rows[0] : rows };
    },
    { schema },
  );
  async function transaction<T>(begin: string, operation: (handle: DatabaseHandle) => Promise<T>) {
    await execute(begin);
    try {
      const value = await operation(handle);
      await execute("COMMIT");
      return value;
    } catch (error) {
      await execute("ROLLBACK");
      throw error;
    }
  }
  const db = createDatabaseAdapter(handle, {
    read: (operation) => transaction("BEGIN DEFERRED", operation),
    write: (operation) => transaction("BEGIN IMMEDIATE", operation),
    migrate: async (prepare) => {
      const plan = await prepare(handle);
      await execute("PRAGMA foreign_keys=OFF");
      try {
        await transaction("BEGIN DEFERRED", async () => {
          for (const statement of plan) await execute(statement.sql, [...statement.args]);
        });
      } finally {
        await execute("PRAGMA foreign_keys=ON");
      }
    },
  });
  await applyMigrations(db);
  return db;
}
