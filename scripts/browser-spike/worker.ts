import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

declare const __SPIKE_BUILD_ID__: string;
let database: any;
let sqlite: any;
self.onmessage = async ({ data }) => {
  const { id, method, sql, params } = data;
  try {
    if (method === "probe") {
      self.postMessage({ id, result: __SPIKE_BUILD_ID__ });
      return;
    }
    if (method === "initialize") {
      sqlite = await sqlite3InitModule({
        instantiateWasm(
          imports: WebAssembly.Imports,
          receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
        ) {
          const instance = new WebAssembly.Instance(data.module, imports);
          receive(instance, data.module);
          return instance.exports;
        },
      });
      database = new sqlite.oo1.DB(":memory:", "c");
      database.exec("PRAGMA foreign_keys = ON");
      self.postMessage({ id, result: true });
      return;
    }
    if (!database) throw new Error("Database is not initialized");
    if (method === "export") {
      const bytes = sqlite.capi.sqlite3_js_db_export(database.pointer);
      self.postMessage({ id, result: bytes }, [bytes.buffer]);
      return;
    }
    const rows: unknown[][] = [];
    database.exec({ sql, bind: params ?? [], rowMode: "array", resultRows: rows });
    self.postMessage({ id, result: { rows: method === "get" ? rows[0] : rows } });
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : "SQLite operation failed",
    });
  }
};
