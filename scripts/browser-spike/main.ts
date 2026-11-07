import { schemaManifest } from "./schema-manifest";
import { deadline } from "./deadline";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { sql } from "drizzle-orm";
import * as schema from "../../packages/kozane/src/db/schema";
import { OperationQueue } from "../../packages/client/src/backend/operation-queue.js";

import { verifiedWorker, verifiedModule, type AssetManifest } from "./verified-loader";
let worker: Worker;
let sequence = 0;
const pending = new Map<
  number,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
function failWorker(error: Error) {
  queue.dispose();
  worker?.terminate();
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}
function attachWorker() {
  worker.onerror = () => failWorker(new Error("Worker execution failed"));
  worker.onmessageerror = () => failWorker(new Error("Worker response decoding failed"));
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  };
}
function rpc(method: string, extra = {}): Promise<any> {
  return deadline(
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, method, ...extra });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    }),
    method === "probe" ? 10_000 : 30_000,
    () => failWorker(new Error("Worker deadline exceeded")),
  );
}
const queue = new OperationQueue();
const db = drizzle((query, params, method) => rpc(method, { sql: query, params }), { schema });
async function run() {
  const response = await fetch("./manifest.json");
  if (!response.ok) throw new Error("Manifest fetch failed");
  const manifest: AssetManifest = await response.json();
  worker = await verifiedWorker(manifest);
  attachWorker();
  if ((await rpc("probe")) !== manifest.buildId) throw new Error("Worker build mismatch");
  const module = await verifiedModule(manifest);
  await rpc("initialize", { module });
  const fixtureResponse = await fetch("./parity-fixture.json");
  if (!fixtureResponse.ok) throw new Error("Parity fixture fetch failed");
  const fixture = await fixtureResponse.json();
  await queue.run(() =>
    db.transaction(async (tx) => {
      await tx.run(sql.raw(fixture.historyTableSql));
      for (const migration of fixture.migrations) {
        for (const statement of migration.sql) await tx.run(sql.raw(statement));
        await tx.run(
          sql`INSERT INTO __drizzle_migrations(hash, created_at) VALUES(${migration.hash}, ${migration.folderMillis})`,
        );
      }
    }),
  );
  const actual = await schemaManifest((query) => db.values(sql.raw(query)));
  if (JSON.stringify(actual) !== JSON.stringify(fixture.manifest))
    throw new Error("Browser/libsql schema mismatch");
  const history = await db.values(
    sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at`,
  );
  if (JSON.stringify(history) !== JSON.stringify(fixture.history))
    throw new Error("Browser/libsql migration history mismatch");
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
  .finally(() => failWorker(new Error("Spike finished")));
