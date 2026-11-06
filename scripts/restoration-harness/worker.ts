import sqlite3InitModule, { type SqlValue } from "@sqlite.org/sqlite-wasm";
type SQLite = Awaited<ReturnType<typeof sqlite3InitModule>>;
// The published loader declaration omits Emscripten overrides supported by its runtime.
const initialize = sqlite3InitModule as unknown as (options: {
  instantiateWasm(
    imports: WebAssembly.Imports,
    receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ): WebAssembly.Exports;
}) => Promise<SQLite>;
import { OperationQueue } from "./operation-queue";
declare const __SPIKE_BUILD_ID__: string;
let sqlite: Awaited<ReturnType<typeof sqlite3InitModule>>;
let database: InstanceType<typeof sqlite.oo1.DB> | undefined;
const queue = new OperationQueue();
self.onmessage = ({ data }) => {
  void queue.run(async () => {
    const { id, method } = data;
    try {
      let result: unknown;
      if (method === "probe") result = __SPIKE_BUILD_ID__;
      else if (method === "initialize") {
        sqlite = await initialize({
          instantiateWasm(imports, receive) {
            const instance = new WebAssembly.Instance(data.module, imports);
            receive(instance, data.module);
            return instance.exports;
          },
        });
        result = true;
      } else if (method === "open") {
        database?.close();
        database = undefined;
        sqlite.capi.sqlite3_js_posix_create_file("/candidate.db", new Uint8Array(data.bytes));
        database = new sqlite.oo1.DB("/candidate.db", "w");
        database.exec("PRAGMA foreign_keys=ON");
        result = true;
      } else if (method === "close") {
        database?.close();
        database = undefined;
        result = true;
      } else {
        if (!database) throw new Error("Candidate is not open");
        const rows: SqlValue[][] = [];
        database.exec({ sql: data.sql, bind: data.args ?? [], rowMode: "array", resultRows: rows });
        result = { rows: method === "get" ? (rows[0] ?? []) : rows };
      }
      self.postMessage({ id, result });
    } catch (error) {
      const code = sqlite && error instanceof sqlite.SQLite3Error ? error.resultCode & 255 : 0;
      const kind =
        code === 11 || code === 26
          ? "database_content"
          : code === 5 || code === 6
            ? "transient"
            : "unknown";
      self.postMessage({ id, error: { kind, message: "Candidate database operation failed" } });
    }
  });
};
