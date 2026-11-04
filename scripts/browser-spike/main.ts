import { drizzle } from "drizzle-orm/sqlite-proxy";
import { sql } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { OperationQueue } from "../../src/lib/backend/operation-queue";

const worker = new Worker(new URL("./worker.js", location.href), { type: "module" });
let sequence = 0;
const pending = new Map<
  number,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
worker.onmessage = ({ data }) => {
  const request = pending.get(data.id);
  if (!request) return;
  pending.delete(data.id);
  if (data.error) request.reject(new Error(data.error));
  else request.resolve(data.result);
};
function rpc(method: string, extra = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, method, ...extra });
  });
}
const queue = new OperationQueue();
const db = drizzle((query, params, method) => rpc(method, { sql: query, params }), { schema });
async function run() {
  await rpc("probe");
  await rpc("initialize", { wasmUrl: new URL("./sqlite3.wasm", location.href).href });
  await db.run(sql`create table spike_parent (id integer primary key)`);
  await db.run(sql`create table spike_child (parent integer references spike_parent(id))`);
  await queue.run(() =>
    db.transaction(
      async (tx) => {
        await tx.run(sql`insert into spike_parent values (1)`);
        await tx.run(sql`insert into spike_child values (1)`);
      },
      { behavior: "immediate" },
    ),
  );
  try {
    await queue.run(() =>
      db.transaction(async (tx) => {
        await tx.run(sql`insert into spike_parent values (2)`);
        throw new Error("rollback fixture");
      }),
    );
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "rollback fixture") throw error;
  }
  const rows = await queue.run(() => db.values(sql`select id from spike_parent order by id`));
  if (JSON.stringify(rows) !== "[[1]]") throw new Error("Rollback failed");
  let foreignKeys = false;
  try {
    await db.run(sql`insert into spike_child values (99)`);
  } catch {
    foreignKeys = true;
  }
  if (!foreignKeys) throw new Error("Foreign keys are disabled");
  const returned = await db.values(sql`insert into spike_parent values (3) returning id`);
  if (JSON.stringify(returned) !== "[[3]]") throw new Error("RETURNING failed");
  const bytes = await queue.run(() => rpc("export"));
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error("Export failed");
  document.body.textContent =
    "PASS: proxy transactions, rollback, foreign keys, RETURNING and export";
}
run()
  .catch((error) => {
    document.body.textContent = `FAIL: ${error.message}`;
  })
  .finally(() => worker.terminate());
