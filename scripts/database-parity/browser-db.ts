import { onTestFinished } from "vitest";
import { createWasmDatabase } from "./adapter.js";
export * from "../../packages/kozane/src/test-utils/db-common.js";
const exports = new WeakMap<object, () => Promise<Uint8Array>>();
export async function exportTestDB(db: object) {
  return exports.get(db)!();
}
export async function createTestDB() {
  const worker = new Worker(new URL("./api-worker.ts", import.meta.url), { type: "module" });
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve(rows: unknown[][]): void; reject(error: Error): void }
  >();
  const fail = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    worker.terminate();
  };
  worker.onerror = () => fail(new Error("Database parity worker failed"));
  worker.onmessageerror = () => fail(new Error("Database parity worker response failed"));
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.rows);
  };
  onTestFinished(() => fail(new Error("Database parity test finished")));
  const db = await createWasmDatabase(
    (sql, args = []) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, sql, args });
      }),
  );
  exports.set(
    db,
    () =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve: resolve as unknown as (rows: unknown[][]) => void, reject });
        worker.postMessage({ id, method: "export" });
      }),
  );
  return db;
}
