import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import wasmUrl from "@sqlite.org/sqlite-wasm/sqlite3.wasm?url";
const initialize = sqlite3InitModule as unknown as (options: {
  locateFile(): string;
}) => ReturnType<typeof sqlite3InitModule>;
const ready = initialize({ locateFile: () => wasmUrl }).then((sqlite) => ({
  sqlite,
  database: new sqlite.oo1.DB(":memory:", "c"),
}));
self.onmessage = async ({ data }) => {
  try {
    const { sqlite, database } = await ready;
    if (data.method === "export") {
      self.postMessage({ id: data.id, rows: sqlite.capi.sqlite3_js_db_export(database.pointer!) });
      return;
    }
    const rows: unknown[][] = [];
    database.exec({
      sql: data.sql,
      bind: data.args,
      rowMode: "array",
      resultRows: rows as never[],
    });
    self.postMessage({ id: data.id, rows });
  } catch (error) {
    self.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
