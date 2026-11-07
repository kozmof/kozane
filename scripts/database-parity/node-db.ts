import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { onTestFinished } from "vitest";
import { createWasmDatabase } from "./adapter.js";
export * from "../../packages/kozane/src/test-utils/db-common.js";
const sqlite = await sqlite3InitModule();
const exports = new WeakMap<object, () => Uint8Array>();
export async function exportTestDB(db: object) {
  return exports.get(db)!();
}
export async function createTestDB() {
  const engine = new sqlite.oo1.DB(":memory:", "c");
  onTestFinished(() => engine.close());
  const db = await createWasmDatabase(async (sql, args = []) => {
    const rows: unknown[][] = [];
    engine.exec({ sql, bind: args as never[], rowMode: "array", resultRows: rows as never[] });
    return rows;
  });
  exports.set(db, () => sqlite.capi.sqlite3_js_db_export(engine.pointer!));
  return db;
}
