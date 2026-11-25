import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import { openDb } from "../../db/client.js";
import { migrateNodeDatabase } from "../../db/tx.js";
import { installCapturePrototype, openCapturePrototype } from "../../test-utils/action-capture.js";
import {
  beginCaptureEpochTransition,
  runCaptureMigrationBatch,
  prepareCaptureEpochBaseline,
  activateCaptureEpoch,
  type PrototypeEpochTransition,
} from "../../test-utils/action-epochs.js";
import {
  withTx,
  withReadTx,
  createDatabaseAdapter,
  type DatabaseHandle,
  type DB,
} from "../../../../core/src/database.js";

let root: string | undefined;
const handles: Awaited<ReturnType<typeof openDb>>[] = [];
async function open() {
  const handle = await openDb(`file:${join(root!, "epoch.sqlite")}`);
  handles.push(handle);
  // The source fixtures and packed application database expose distinct TypeScript brands.
  return { db: handle.db as unknown as DB, close: handle.close };
}
async function factory() {
  const handle = await openDb(":memory:");
  handles.push(handle);
  return handle.db as unknown as DB;
}
async function fixture() {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
  root = await fs.mkdtemp(join(tmpdir(), "kozane-epoch-"));
  const handle = await open();
  await migrateNodeDatabase(handle.db as unknown as Parameters<typeof migrateNodeDatabase>[0], {
    migrationsFolder: resolve("drizzle"),
  });
  await handle.db.run(sql`INSERT INTO scope VALUES('s','Before')`);
  await installCapturePrototype(handle.db);
  const epoch = await handle.db.values(sql`SELECT epoch_id,schema_id FROM capture_epoch`);
  const request: PrototypeEpochTransition = {
    id: "migration",
    sourceEpoch: String(epoch[0][0]),
    sourceSchema: String(epoch[0][1]),
    targetEpoch: "target",
    targetSchema: "next-schema",
    batches: ["repair"],
  };
  return { handle, request };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const handle of handles.splice(0)) handle.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});
it("keeps application writes blocked across restarts before repair, after its commit and after baseline preparation", async () => {
  const { handle, request } = await fixture();
  await beginCaptureEpochTransition(handle.db, request);
  handle.close();
  const resumed = await open();
  await expect(resumed.db.run(sql`UPDATE scope SET name='Unstamped'`)).rejects.toThrow();
  const repair = vi.fn(
    async (tx: Parameters<Parameters<typeof runCaptureMigrationBatch>[3]>[0]) => {
      await tx.run(sql`UPDATE scope SET name='Repaired' WHERE id='s'`);
      await tx.run(sql`CREATE TABLE repaired_once(id TEXT PRIMARY KEY)`);
      await tx.run(sql`INSERT INTO repaired_once VALUES('only-once')`);
    },
  );
  await runCaptureMigrationBatch(resumed.db, request, 0, repair);
  resumed.close();
  const afterRepair = await open();
  expect((await runCaptureMigrationBatch(afterRepair.db, request, 0, repair)).changed).toBe(false);
  expect(repair).toHaveBeenCalledTimes(1);
  await expect(
    prepareCaptureEpochBaseline(afterRepair.db, request, async () => {
      throw Error("Interrupted capture");
    }),
  ).rejects.toThrow("Interrupted capture");
  afterRepair.close();
  const afterFailure = await open();
  await expect(afterFailure.db.run(sql`UPDATE scope SET name='Unstamped'`)).rejects.toThrow();
  await prepareCaptureEpochBaseline(afterFailure.db, request, factory);
  afterFailure.close();
  const afterCandidate = await open();
  await expect(afterCandidate.db.run(sql`UPDATE scope SET name='Unstamped'`)).rejects.toThrow();
  expect((await activateCaptureEpoch(afterCandidate.db, request)).changed).toBe(true);
  afterCandidate.close();
  const active = await open();
  await (await openCapturePrototype(active.db)).verify();
  expect((await active.db.values(sql`SELECT name FROM scope`))[0][0]).toBe("Repaired");
  expect((await activateCaptureEpoch(active.db, request)).changed).toBe(false);
  expect(repair).toHaveBeenCalledTimes(1);
});
it("serializes competing batch callbacks and preserves committed progress after waiting writers retry", async () => {
  const { handle, request } = await fixture();
  const second = await open();
  await beginCaptureEpochTransition(handle.db, request);
  await second.db.values(sql`PRAGMA busy_timeout=1`);
  const entered = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>();
  const wrapped = createDatabaseAdapter(new Proxy(handle.db, {}), {
    read: (work) => withReadTx(handle.db, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(handle.db, async (tx) => {
        const result = await work(tx);
        entered.resolve();
        await proceed.promise;
        return result;
      }),
  });
  const callback = vi.fn(
    async (tx: Parameters<Parameters<typeof runCaptureMigrationBatch>[3]>[0]) => {
      await tx.run(sql`UPDATE scope SET name='Once' WHERE id='s'`);
    },
  );
  const pending = runCaptureMigrationBatch(wrapped, request, 0, callback),
    settled = pending.then(
      (result) => ({ result, error: null }),
      (error) => ({ result: null, error }),
    );
  try {
    await Promise.race([
      entered.promise,
      settled.then((value) => {
        throw value.error ?? Error("Batch ended early");
      }),
    ]);
    const duplicate = vi.fn(async () => {});
    await expect(runCaptureMigrationBatch(second.db, request, 0, duplicate)).rejects.toThrow();
    expect(duplicate).not.toHaveBeenCalled();
    expect(
      (await second.db.values(sql`SELECT next_batch FROM capture_epoch_transition`))[0][0],
    ).toBe(0);
    proceed.resolve();
    expect((await settled).error).toBeNull();
    expect((await runCaptureMigrationBatch(second.db, request, 0, duplicate)).changed).toBe(false);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(duplicate).not.toHaveBeenCalled();
    await expect(second.db.run(sql`UPDATE scope SET name='Unstamped'`)).rejects.toThrow();
  } finally {
    proceed.resolve();
    await settled;
  }
});
