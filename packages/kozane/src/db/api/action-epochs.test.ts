import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
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
  type DB,
  type Tx,
  type DatabaseHandle,
} from "../../../../core/src/database.js";
import { defineActionRegistry } from "../../../../core/src/actions/registry.js";
import { runActionGroup } from "../../../../core/src/actions/execution.js";
import { createActionBindings } from "../../../../core/src/actions/bindings.js";
import { buildAssetManifest } from "../../../../core/src/actions/asset-manifest.js";

const factory = async () => (await createTestDB()) as unknown as DB;
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const db = await factory();
  await db.run(sql`INSERT INTO scope(id,name) VALUES('s','Before')`);
  await db.run(
    sql`INSERT INTO taskspace_local VALUES('absent','local/retained','workspace_relative',9007199254740993)`,
  );
  const capture = await installCapturePrototype(db);
  const [[sourceEpoch, sourceSchema]] = await rows(
    db,
    "SELECT epoch_id,schema_id FROM capture_epoch",
  );
  const request: PrototypeEpochTransition = {
    id: "transition-1",
    sourceEpoch: String(sourceEpoch),
    sourceSchema: String(sourceSchema),
    targetEpoch: "epoch-1",
    targetSchema: "schema-1",
    batches: ["repair", "rebuild"],
  };
  return { db, capture, request };
}
const rows = async (db: DB, query: string) =>
  (await db.values(sql.raw(query))).map((row) => Array.from(row));
const state = (db: DB) =>
  rows(
    db,
    "SELECT next_batch,state,candidate IS NOT NULL FROM capture_epoch_transition ORDER BY id",
  );
const marker = (db: DB) =>
  rows(db, "SELECT mode,run_id,action_id,execution_ord,next_effect_ord FROM capture_context");
const emptyMarker = [["record", null, null, null, 0]];
function run(
  db: DB,
  capture: Awaited<ReturnType<typeof openCapturePrototype>>,
  id: string,
  name: string | null,
) {
  const registry = defineActionRegistry<{ rename: unknown }, { db: Tx }>({
    contractVersion: 1,
    schemaVersions: [19],
    definitions: {
      rename: {
        eligibility: "syncable",
        prepare: (input) => input,
        replay: async (_input, execution) => {
          if (name !== null)
            await execution.context.db.run(sql`UPDATE scope SET name=${name} WHERE id='s'`);
        },
      },
    },
  });
  return runActionGroup({
    db,
    registry,
    schemaVersion: 19,
    invocation: { id: id + "-root", kind: "rename", contractVersion: 1, input: {} },
    bindings: createActionBindings({
      mode: "record",
      allocateId: () => {
        throw Error("Unexpected allocation");
      },
      now: () => {
        throw Error("Unexpected clock");
      },
    }),
    createContext: (_actions, db) => ({ db }),
    ...capture.hooks(id),
  });
}
const repair = async (tx: Tx) => {
  await tx.run(sql`UPDATE scope SET name='Repaired' WHERE id='s'`);
  await tx.run(sql`CREATE TABLE migration_repair(id TEXT PRIMARY KEY,attempts INTEGER NOT NULL)`);
  await tx.run(sql`INSERT INTO migration_repair VALUES('repair',1)`);
};
async function rebuild(tx: Tx) {
  const definitions = await tx.values(
    sql`SELECT definition FROM capture_guard_catalog WHERE name IN ('capture_scope_I','capture_scope_U','capture_scope_D') ORDER BY name`,
  );
  await tx.run(
    sql`CREATE TABLE scope_replacement(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL)`,
  );
  await tx.run(sql`INSERT INTO scope_replacement SELECT * FROM scope`);
  await tx.run(sql`DROP TABLE scope`);
  await tx.run(sql`ALTER TABLE scope_replacement RENAME TO scope`);
  for (const row of definitions) await tx.run(sql.raw(String(row[0])));
}
async function completeBatches(f: Awaited<ReturnType<typeof fixture>>) {
  await beginCaptureEpochTransition(f.db, f.request);
  await runCaptureMigrationBatch(f.db, f.request, 0, repair);
  await runCaptureMigrationBatch(f.db, f.request, 1, rebuild);
}
it("blocks actions, no-op actions, restore mode and raw writes until a prepared epoch activates", async () => {
  const f = await fixture();
  await run(f.db, f.capture, "old", "Recorded");
  const oldRuns = await rows(f.db, "SELECT id,epoch_id FROM capture_run");
  const oldEffects = await rows(
    f.db,
    "SELECT run_id,ord,before_image,after_image FROM capture_effect",
  );
  const local = await rows(
    f.db,
    "SELECT taskspace_id,path,CAST(last_seen_at AS TEXT) FROM taskspace_local",
  );
  await beginCaptureEpochTransition(f.db, f.request);
  await expect(run(f.db, f.capture, "blocked", "Never")).rejects.toThrow("blocked");
  await expect(run(f.db, f.capture, "noop", null)).rejects.toThrow("blocked");
  await expect(f.db.run(sql`UPDATE scope SET name='raw'`)).rejects.toThrow();
  await expect(f.capture.restore(factory, [])).rejects.toThrow("blocked");
  await runCaptureMigrationBatch(f.db, f.request, 0, repair);
  await runCaptureMigrationBatch(f.db, f.request, 1, rebuild);
  await expect(activateCaptureEpoch(f.db, f.request)).rejects.toThrow("prepared");
  const prepared = await prepareCaptureEpochBaseline(f.db, f.request, factory);
  expect(prepared.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(await state(f.db)).toEqual([[2, "active", 1]]);
  await expect(run(f.db, f.capture, "still-blocked", null)).rejects.toThrow("blocked");
  expect((await activateCaptureEpoch(f.db, f.request)).changed).toBe(true);
  expect(await rows(f.db, "SELECT id,epoch_id FROM capture_run")).toEqual(oldRuns);
  expect(
    await rows(f.db, "SELECT run_id,ord,before_image,after_image FROM capture_effect"),
  ).toEqual(oldEffects);
  expect(
    await rows(f.db, "SELECT taskspace_id,path,CAST(last_seen_at AS TEXT) FROM taskspace_local"),
  ).toEqual(local);
  expect(await rows(f.db, "SELECT run_id FROM capture_selection")).toEqual([]);
  expect(await rows(f.db, "SELECT epoch_id,schema_id FROM capture_epoch")).toEqual([
    ["epoch-1", "schema-1"],
  ]);
  const reopened = await openCapturePrototype(f.db);
  await reopened.verify();
  await expect(reopened.restore(factory, ["old"])).rejects.toThrow("Missing or incomplete");
  await run(f.db, reopened, "new", "New epoch");
  expect(await reopened.selection()).toEqual(["new"]);
  expect((await activateCaptureEpoch(f.db, f.request)).changed).toBe(false);
  expect(await rows(f.db, "SELECT name FROM scope")).toEqual([["New epoch"]]);
  await reopened.verify();
  await expect(f.db.run(sql`UPDATE scope SET name='raw'`)).rejects.toThrow();
});
it("resumes ordered migration progress and never reruns committed repair callbacks", async () => {
  const f = await fixture();
  await beginCaptureEpochTransition(f.db, f.request);
  const callback = vi.fn(repair);
  await runCaptureMigrationBatch(f.db, f.request, 0, callback);
  expect((await beginCaptureEpochTransition(f.db, f.request)).changed).toBe(false);
  expect((await runCaptureMigrationBatch(f.db, f.request, 0, callback)).changed).toBe(false);
  expect(callback).toHaveBeenCalledTimes(1);
  expect(await rows(f.db, "SELECT attempts FROM migration_repair")).toEqual([[1]]);
  await expect(prepareCaptureEpochBaseline(f.db, f.request, factory)).rejects.toThrow("incomplete");
  expect(await state(f.db)).toEqual([[1, "active", 0]]);
  await runCaptureMigrationBatch(f.db, f.request, 1, rebuild);
  const failed = vi.fn(async () => {
    throw Error("Validation failed");
  });
  await expect(prepareCaptureEpochBaseline(f.db, f.request, failed)).rejects.toThrow(
    "Validation failed",
  );
  expect(await state(f.db)).toEqual([[2, "active", 0]]);
  expect((await runCaptureMigrationBatch(f.db, f.request, 0, callback)).changed).toBe(false);
  expect(callback).toHaveBeenCalledTimes(1);
  await prepareCaptureEpochBaseline(f.db, f.request, factory);
  expect((await prepareCaptureEpochBaseline(f.db, f.request, factory)).changed).toBe(false);
  await activateCaptureEpoch(f.db, f.request);
});
it("rolls back failed repair data, schema, progress, history and migration mode atomically", async () => {
  const f = await fixture();
  await beginCaptureEpochTransition(f.db, f.request);
  await expect(
    runCaptureMigrationBatch(f.db, f.request, 0, async (tx) => {
      await repair(tx);
      throw Error("Repair failed");
    }),
  ).rejects.toThrow("Repair failed");
  expect(await rows(f.db, "SELECT name FROM scope")).toEqual([["Before"]]);
  expect(await rows(f.db, "SELECT name FROM sqlite_schema WHERE name='migration_repair'")).toEqual(
    [],
  );
  expect(await state(f.db)).toEqual([[0, "active", 0]]);
  expect(await rows(f.db, "SELECT * FROM capture_migration_history")).toEqual([]);
  expect(await marker(f.db)).toEqual(emptyMarker);
  expect(await rows(f.db, "SELECT transition_id,batch FROM capture_migration_boundary")).toEqual([
    [null, null],
  ]);
  await runCaptureMigrationBatch(f.db, f.request, 0, repair);
});
it("requires guards to survive table rebuilds and rolls back a batch that drops one", async () => {
  const f = await fixture();
  await beginCaptureEpochTransition(f.db, f.request);
  await expect(
    runCaptureMigrationBatch(f.db, f.request, 0, async (tx) => {
      await tx.run(sql`DROP TRIGGER capture_scope_U`);
      await repair(tx);
    }),
  ).rejects.toThrow("guards changed");
  expect(
    await rows(f.db, "SELECT name FROM sqlite_schema WHERE name='capture_scope_U'"),
  ).toHaveLength(1);
  expect(await state(f.db)).toEqual([[0, "active", 0]]);
  await runCaptureMigrationBatch(f.db, f.request, 0, repair);
  await runCaptureMigrationBatch(f.db, f.request, 1, rebuild);
  expect(
    await rows(
      f.db,
      "SELECT name FROM sqlite_schema WHERE name IN ('capture_scope_I','capture_scope_U','capture_scope_D')",
    ),
  ).toHaveLength(3);
});
it("refuses migrate mode without the exact active batch marker", async () => {
  const f = await fixture();
  await f.db.run(sql`UPDATE capture_context SET mode='migrate'`);
  await expect(f.db.run(sql`UPDATE scope SET name='Forged'`)).rejects.toThrow();
  await f.db.run(sql`UPDATE capture_context SET mode='record'`);
  await beginCaptureEpochTransition(f.db, f.request);
  await f.db.run(sql`UPDATE capture_context SET mode='migrate'`);
  await expect(f.db.run(sql`UPDATE scope SET name='Forged'`)).rejects.toThrow();
  await f.db.run(sql`UPDATE capture_migration_boundary SET transition_id='transition-1',batch=1`);
  await expect(f.db.run(sql`UPDATE scope SET name='Wrong batch'`)).rejects.toThrow();
  await f.db.run(sql`UPDATE capture_context SET mode='record'`);
  await f.db.run(sql`UPDATE capture_migration_boundary SET transition_id=NULL,batch=NULL`);
  await runCaptureMigrationBatch(f.db, f.request, 0, repair);
});
it("refuses changed requests, wrong source epochs, concurrent transitions and out-of-order batches", async () => {
  const f = await fixture();
  await expect(
    beginCaptureEpochTransition(f.db, { ...f.request, sourceEpoch: "wrong" }),
  ).rejects.toThrow("source identity");
  await beginCaptureEpochTransition(f.db, f.request);
  await expect(beginCaptureEpochTransition(f.db, { ...f.request, id: "other" })).rejects.toThrow(
    "blocked",
  );
  await expect(
    beginCaptureEpochTransition(f.db, { ...f.request, targetEpoch: "other" }),
  ).rejects.toThrow("request");
  await expect(runCaptureMigrationBatch(f.db, f.request, 1, rebuild)).rejects.toThrow(
    "out of order",
  );
  await f.db.run(sql`INSERT INTO capture_migration_history VALUES('transition-1',0,'forged')`);
  await expect(runCaptureMigrationBatch(f.db, f.request, 0, repair)).rejects.toThrow(
    "history disagrees",
  );
});
it("refuses active execution or restoration markers before starting a transition", async () => {
  const f = await fixture();
  for (const assignment of [
    "mode='restore'",
    "run_id='running'",
    "action_id='action'",
    "execution_ord=0",
    "next_effect_ord=1",
  ]) {
    await f.db.run(sql.raw(`UPDATE capture_context SET ${assignment}`));
    await expect(beginCaptureEpochTransition(f.db, f.request)).rejects.toThrow("empty");
    await f.db.run(
      sql`UPDATE capture_context SET mode='record',run_id=NULL,action_id=NULL,execution_ord=NULL,next_effect_ord=0`,
    );
  }
  expect(await state(f.db)).toEqual([]);
});
it("detects archived history mutation and rolls back marker tampering inside a batch", async () => {
  const f = await fixture();
  await run(f.db, f.capture, "old", "Recorded");
  await beginCaptureEpochTransition(f.db, f.request);
  await expect(
    runCaptureMigrationBatch(f.db, f.request, 0, async (tx) => {
      await tx.run(sql`UPDATE capture_effect SET after_image='{}'`);
    }),
  ).rejects.toThrow("archived action history");
  await expect(
    runCaptureMigrationBatch(f.db, f.request, 0, async (tx) => {
      await tx.run(sql`UPDATE capture_context SET action_id='wrong'`);
    }),
  ).rejects.toThrow("marker changed");
  await expect(
    runCaptureMigrationBatch(f.db, f.request, 0, async (tx) => {
      await tx.run(
        sql`UPDATE capture_epoch_transition SET candidate='{}' WHERE id=${f.request.id}`,
      );
    }),
  ).rejects.toThrow("changed transition progress or candidate");
  await expect(
    runCaptureMigrationBatch(f.db, f.request, 0, async (tx) => {
      await repair(tx);
      await tx.values(sql`PRAGMA recursive_triggers=OFF`);
    }),
  ).rejects.toThrow("recursive_triggers");
  expect(await marker(f.db)).toEqual(emptyMarker);
  expect(await state(f.db)).toEqual([[0, "active", 0]]);
});
it("refuses changed rows, schema, guards or candidate hashes before activation", async () => {
  const f = await fixture();
  await completeBatches(f);
  await prepareCaptureEpochBaseline(f.db, f.request, factory);
  const [[candidate]] = await rows(f.db, "SELECT candidate FROM capture_epoch_transition");
  const value = JSON.parse(String(candidate));
  value.sha256 = "0".repeat(64);
  await f.db.run(sql`UPDATE capture_epoch_transition SET candidate=${JSON.stringify(value)}`);
  await expect(activateCaptureEpoch(f.db, f.request)).rejects.toThrow("baseline changed");
  await f.db.run(sql`UPDATE capture_epoch_transition SET candidate=${String(candidate)}`);
  await f.db.run(sql`CREATE TABLE schema_changed(id TEXT)`);
  await expect(activateCaptureEpoch(f.db, f.request)).rejects.toThrow("baseline changed");
  await f.db.run(sql`DROP TABLE schema_changed`);
  const [[guard]] = await rows(
    f.db,
    "SELECT definition FROM capture_guard_catalog WHERE name='capture_scope_U'",
  );
  await f.db.run(sql`DROP TRIGGER capture_scope_U`);
  await f.db.run(sql`UPDATE scope SET name='Changed after preparation' WHERE id='s'`);
  await f.db.run(sql.raw(String(guard)));
  await expect(activateCaptureEpoch(f.db, f.request)).rejects.toThrow("baseline changed");
  expect(await state(f.db)).toEqual([[2, "active", 1]]);
  await expect(run(f.db, f.capture, "blocked", null)).rejects.toThrow("blocked");
});
it("refuses a stale candidate when rows or schema change during isolated validation", async () => {
  const f = await fixture();
  await completeBatches(f);
  await expect(
    prepareCaptureEpochBaseline(f.db, f.request, async () => {
      await f.db.run(sql`CREATE TABLE changed_while_validating(id TEXT)`);
      return factory();
    }),
  ).rejects.toThrow("changed during validation");
  expect(await state(f.db)).toEqual([[2, "active", 0]]);
  await expect(prepareCaptureEpochBaseline(f.db, f.request, async () => f.db)).rejects.toThrow(
    "separate database",
  );
});
it("rejects failed transition, batch, baseline and activation commits without publishing progress or changing the active epoch", async () => {
  const f = await fixture();
  const wrapped = createDatabaseAdapter(new Proxy(f.db, {}), {
    read: (work) => withReadTx(f.db, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(f.db, async (tx) => {
        await work(tx);
        throw Error("Commit failed");
      }),
  });
  await expect(beginCaptureEpochTransition(wrapped, f.request)).rejects.toThrow("Commit failed");
  expect(await state(f.db)).toEqual([]);
  await beginCaptureEpochTransition(f.db, f.request);
  await expect(runCaptureMigrationBatch(wrapped, f.request, 0, repair)).rejects.toThrow(
    "Commit failed",
  );
  expect(await state(f.db)).toEqual([[0, "active", 0]]);
  await runCaptureMigrationBatch(f.db, f.request, 0, repair);
  await runCaptureMigrationBatch(f.db, f.request, 1, rebuild);
  await expect(prepareCaptureEpochBaseline(wrapped, f.request, factory)).rejects.toThrow(
    "Commit failed",
  );
  expect(await state(f.db)).toEqual([[2, "active", 0]]);
  await prepareCaptureEpochBaseline(f.db, f.request, factory);
  await expect(activateCaptureEpoch(wrapped, f.request)).rejects.toThrow("Commit failed");
  expect(await rows(f.db, "SELECT epoch_id FROM capture_epoch")).toEqual([["initial"]]);
  expect(await state(f.db)).toEqual([[2, "active", 1]]);
  expect(await rows(f.db, "SELECT * FROM capture_epoch_archive")).toEqual([]);
  await activateCaptureEpoch(f.db, f.request);
});
it("verifies candidate image bytes again at activation while leaving migration business triggers active", async () => {
  const f = await fixture();
  await beginCaptureEpochTransition(f.db, f.request);
  const filename = "00000000-0000-4000-8000-000000000001.png",
    name = ".kozane/assets/images/" + filename;
  const data = new TextEncoder().encode("original image"),
    read = vi.fn(async () => data);
  const assets = await buildAssetManifest([name], read);
  await runCaptureMigrationBatch(f.db, f.request, 0, async (tx) => {
    await tx.run(sql`INSERT INTO namespace(id,name,is_default) VALUES('n','Main',1)`);
    await tx.run(sql`INSERT INTO layer(id,namespace_id,name,is_default) VALUES('l','n','Base',1)`);
    await tx.run(
      sql`INSERT INTO partition(id,namespace_id,name,is_default) VALUES('p','n','Inbox',1)`,
    );
    await tx.run(
      sql`INSERT INTO card(id,partition_id,layer_id,content) VALUES('image','p','l',${"kozane-image:/api/images/" + filename})`,
    );
  });
  expect(Number((await rows(f.db, "SELECT created_at FROM card"))[0][0])).toBeGreaterThan(0);
  expect(await rows(f.db, "SELECT run_id FROM capture_effect")).toEqual([]);
  await runCaptureMigrationBatch(f.db, f.request, 1, async () => {});
  const corrupt = async () => new TextEncoder().encode("wrong");
  await expect(
    prepareCaptureEpochBaseline(f.db, f.request, factory, assets, corrupt),
  ).rejects.toThrow("bytes do not match");
  await prepareCaptureEpochBaseline(f.db, f.request, factory, assets, read);
  await expect(activateCaptureEpoch(f.db, f.request, corrupt)).rejects.toThrow(
    "bytes do not match",
  );
  expect(await state(f.db)).toEqual([[2, "active", 1]]);
  await activateCaptureEpoch(f.db, f.request, read);
});
