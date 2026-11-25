import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import {
  stageCaptureInitialization,
  prepareCaptureInitialization,
  activateCaptureInitialization,
  captureInitializationOwner,
} from "../../test-utils/action-initialization.js";
import {
  openCapturePrototype,
  captureApplicationRows,
  installCapturePrototype,
} from "../../test-utils/action-capture.js";
import {
  withTx,
  withReadTx,
  createDatabaseAdapter,
  type DB,
  type Tx,
  type DatabaseHandle,
} from "../../../../core/src/database.js";
import { migrations } from "../../../../core/src/generated/migrations.js";
import { defineActionRegistry } from "../../../../core/src/actions/registry.js";
import { runActionGroup } from "../../../../core/src/actions/execution.js";
import { createActionBindings } from "../../../../core/src/actions/bindings.js";
import { buildAssetManifest } from "../../../../core/src/actions/asset-manifest.js";

const factory = async () => (await createTestDB()) as unknown as DB;
const identity = { id: "initial-enable", epochId: "first-active", schemaId: migrations.at(-1)!.id };
const rows = async (db: DB, query: string) =>
  (await db.values(sql.raw(query))).map((row) => Array.from(row));
const state = (db: DB) =>
  rows(db, "SELECT next_batch,state,candidate IS NOT NULL FROM capture_epoch_transition");
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture(populated = true) {
  const db = await factory();
  if (populated) {
    await db.run(sql`INSERT INTO scope VALUES('s','Before')`);
    await db.run(
      sql`INSERT INTO taskspace_local VALUES('absent','local/retained','workspace_relative',9007199254740993)`,
    );
  }
  return db;
}
function run(
  db: DB,
  capture: Awaited<ReturnType<typeof openCapturePrototype>>,
  name: string | null,
) {
  const registry = defineActionRegistry<{ rename: unknown }, { db: Tx }>({
    contractVersion: 1,
    schemaVersions: [19],
    definitions: {
      rename: {
        eligibility: "syncable",
        prepare: (input) => input,
        replay: async (_input, { context }) => {
          if (name !== null) await context.db.run(sql`UPDATE scope SET name=${name} WHERE id='s'`);
        },
      },
    },
  });
  return runActionGroup({
    db,
    registry,
    schemaVersion: 19,
    invocation: { id: "first-action", kind: "rename", contractVersion: 1, input: {} },
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
    ...capture.hooks("first-run"),
  });
}
it.each([false, true])(
  "stages and activates an initial baseline with writes blocked between commits (populated=%s)",
  async (populated) => {
    const db = await fixture(populated),
      before = await captureApplicationRows(db);
    const staged = await stageCaptureInitialization(db, identity);
    expect(staged.changed).toBe(true);
    expect(await state(db)).toEqual([[0, "active", 0]]);
    expect(await rows(db, "SELECT state FROM local_asset_manifest")).toEqual([["pending"]]);
    expect(await captureApplicationRows(db)).toEqual(before);
    const capture = await openCapturePrototype(db);
    await expect(db.run(sql`INSERT INTO scope VALUES('raw','unstamped')`)).rejects.toThrow();
    await expect(run(db, capture, null)).rejects.toThrow("blocked");
    await expect(capture.restore(factory, [])).rejects.toThrow("blocked");
    await expect(activateCaptureInitialization(db, identity)).rejects.toThrow("prepared baseline");
    await prepareCaptureInitialization(db, identity, factory);
    expect(await state(db)).toEqual([[0, "active", 1]]);
    await expect(run(db, capture, null)).rejects.toThrow("blocked");
    expect((await activateCaptureInitialization(db, identity)).changed).toBe(true);
    expect(await state(db)).toEqual([[0, "completed", 1]]);
    expect(await rows(db, "SELECT epoch_id FROM capture_epoch")).toEqual([[identity.epochId]]);
    expect(
      await rows(db, "SELECT owner_kind,state FROM local_asset_manifest ORDER BY owner_kind"),
    ).toEqual([
      ["baseline", "retained"],
      ["pending-work", "released"],
    ]);
    await (await openCapturePrototype(db)).verify();
    await run(db, await openCapturePrototype(db), "After activation");
    const after = await captureApplicationRows(db);
    expect((await stageCaptureInitialization(db, identity)).changed).toBe(false);
    expect((await activateCaptureInitialization(db, identity)).changed).toBe(false);
    expect(await captureApplicationRows(db)).toEqual(after);
    await expect(db.run(sql`INSERT INTO scope VALUES('raw','unstamped')`)).rejects.toThrow();
  },
);
it("acknowledges matching stage retries without recapturing the provisional baseline", async () => {
  const db = await fixture(),
    first = await stageCaptureInitialization(db, identity);
  const original = await rows(db, "SELECT rows,asset_manifest FROM capture_baseline");
  expect(await stageCaptureInitialization(db, identity)).toEqual({ ...first, changed: false });
  await prepareCaptureInitialization(db, identity, factory);
  expect((await stageCaptureInitialization(db, identity)).changed).toBe(false);
  expect(await rows(db, "SELECT rows,asset_manifest FROM capture_baseline")).toEqual(original);
  expect(
    await rows(db, "SELECT 1 FROM capture_run UNION ALL SELECT 1 FROM capture_migration_history"),
  ).toEqual([]);
});
it("rolls back guards, schema, blocking state and pins after a failed staging commit", async () => {
  const db = await fixture(),
    before = await captureApplicationRows(db);
  const wrapped = createDatabaseAdapter(new Proxy(db, {}), {
    read: (work) => withReadTx(db, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(db, async (tx) => {
        await work(tx);
        throw Error("Stage commit failed");
      }),
  });
  await expect(stageCaptureInitialization(wrapped, identity)).rejects.toThrow(
    "Stage commit failed",
  );
  expect(await rows(db, "SELECT name FROM sqlite_schema WHERE name GLOB 'capture_*'")).toEqual([]);
  expect(await rows(db, "SELECT 1 FROM local_asset_manifest")).toEqual([]);
  expect(await captureApplicationRows(db)).toEqual(before);
  await stageCaptureInitialization(db, identity);
});
it("preserves durable blocking and both pending pins after validation or candidate commit failure", async () => {
  const db = await fixture();
  await stageCaptureInitialization(db, identity);
  await expect(
    prepareCaptureInitialization(db, identity, async () => {
      throw Error("Validation interrupted");
    }),
  ).rejects.toThrow("Validation interrupted");
  expect(await state(db)).toEqual([[0, "active", 0]]);
  expect(await rows(db, "SELECT state FROM local_asset_manifest ORDER BY owner_kind")).toEqual([
    ["pending"],
    ["pending"],
  ]);
  let writes = 0;
  const wrapped = createDatabaseAdapter(new Proxy(db, {}), {
    read: (work) => withReadTx(db, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(db, async (tx) => {
        const result = await work(tx);
        if (++writes === 2) throw Error("Candidate commit failed");
        return result;
      }),
  });
  await expect(prepareCaptureInitialization(wrapped, identity, factory)).rejects.toThrow(
    "Candidate commit failed",
  );
  expect(await state(db)).toEqual([[0, "active", 0]]);
  expect(await rows(db, "SELECT state FROM local_asset_manifest ORDER BY owner_kind")).toEqual([
    ["pending"],
    ["pending"],
  ]);
  await expect(run(db, await openCapturePrototype(db), null)).rejects.toThrow("blocked");
  await prepareCaptureInitialization(db, identity, factory);
  await activateCaptureInitialization(db, identity);
});
it("rolls back activation and staging pin release after a failed final commit", async () => {
  const db = await fixture();
  await stageCaptureInitialization(db, identity);
  await prepareCaptureInitialization(db, identity, factory);
  const wrapped = createDatabaseAdapter(new Proxy(db, {}), {
    read: (work) => withReadTx(db, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(db, async (tx) => {
        await work(tx);
        throw Error("Activation commit failed");
      }),
  });
  await expect(activateCaptureInitialization(wrapped, identity)).rejects.toThrow(
    "Activation commit failed",
  );
  expect(await state(db)).toEqual([[0, "active", 1]]);
  expect(await rows(db, "SELECT epoch_id FROM capture_epoch")).toEqual([["initial"]]);
  expect(
    await rows(db, "SELECT owner_kind,state FROM local_asset_manifest ORDER BY owner_kind"),
  ).toEqual([
    ["baseline", "retained"],
    ["pending-work", "pending"],
  ]);
  expect(await rows(db, "SELECT 1 FROM capture_epoch_archive")).toEqual([]);
  await activateCaptureInitialization(db, identity);
});
it("rolls back epoch activation if completion cannot release the staging owner", async () => {
  const db = await fixture();
  await stageCaptureInitialization(db, identity);
  await db.run(sql`CREATE TABLE initial_release_control(blocked INTEGER)`);
  await db.run(sql`INSERT INTO initial_release_control VALUES(1)`);
  await db.run(
    sql`CREATE TRIGGER reject_initial_release BEFORE UPDATE ON local_asset_manifest WHEN NEW.owner_kind='pending-work' AND NEW.state='released' AND (SELECT blocked FROM initial_release_control)=1 BEGIN SELECT RAISE(ABORT,'Initial release refused'); END`,
  );
  await prepareCaptureInitialization(db, identity, factory);
  const failure = await activateCaptureInitialization(db, identity).then(
    () => null,
    (error) => error,
  );
  const messages: string[] = [];
  for (let current = failure; current; current = current.cause)
    messages.push(String(current.message));
  expect(messages.join("\n")).toContain("Initial release refused");
  expect(await state(db)).toEqual([[0, "active", 1]]);
  expect(
    await rows(db, "SELECT state FROM local_asset_manifest WHERE owner_kind='pending-work'"),
  ).toEqual([["pending"]]);
  await db.run(sql`UPDATE initial_release_control SET blocked=0`);
  await activateCaptureInitialization(db, identity);
});
it("refuses conflicting requests, unsupported sources and adoption of an unrelated capture fixture", async () => {
  const db = await fixture();
  await stageCaptureInitialization(db, identity);
  for (const input of [
    { ...identity, id: "other" },
    { ...identity, epochId: "other" },
  ])
    await expect(stageCaptureInitialization(db, input)).rejects.toThrow(
      "request is missing or different",
    );
  const unrelated = await fixture();
  await installCapturePrototype(unrelated);
  await expect(stageCaptureInitialization(unrelated, identity)).rejects.toThrow(
    "request is missing or different",
  );
  const altered = await fixture();
  await altered.run(sql`CREATE TABLE unsupported(id TEXT)`);
  await expect(stageCaptureInitialization(altered, identity)).rejects.toThrow("canonical schema");
  expect(await rows(altered, "SELECT name FROM sqlite_schema WHERE name GLOB 'capture_*'")).toEqual(
    [],
  );
});
it("requires complete migration history and valid initial identities before installing any capture state", async () => {
  const db = await fixture();
  for (const input of [
    { ...identity, id: " " },
    { ...identity, epochId: "initial" },
    { ...identity, schemaId: "unsupported" },
  ])
    await expect(stageCaptureInitialization(db, input)).rejects.toThrow("identity or schema");
  await db.run(
    sql`DELETE FROM __drizzle_migrations WHERE created_at=(SELECT max(created_at) FROM __drizzle_migrations)`,
  );
  await expect(stageCaptureInitialization(db, identity)).rejects.toThrow();
  expect(await rows(db, "SELECT name FROM sqlite_schema WHERE name GLOB 'capture_*'")).toEqual([]);
});
it("keeps invalid source rows blocked when isolated initial baseline validation fails", async () => {
  const db = await fixture();
  await db.values(sql`PRAGMA foreign_keys=OFF`);
  await db.run(sql`INSERT INTO warp(id,namespace_id,pos_x,pos_y) VALUES('invalid','missing',0,0)`);
  await db.values(sql`PRAGMA foreign_keys=ON`);
  await stageCaptureInitialization(db, identity);
  await expect(prepareCaptureInitialization(db, identity, factory)).rejects.toThrow();
  expect(await state(db)).toEqual([[0, "active", 0]]);
  await expect(run(db, await openCapturePrototype(db), null)).rejects.toThrow("blocked");
});
it("reserves initial image identity before verification and transfers protection only with activation", async () => {
  const db = await fixture(),
    filename = "00000000-0000-4000-8000-000000000001.png",
    name = ".kozane/assets/images/" + filename;
  const data = new TextEncoder().encode("initial image"),
    read = vi.fn(async () => data),
    catalog = await buildAssetManifest([name], read);
  read.mockClear();
  await db.run(sql`INSERT INTO namespace(id,name,is_default) VALUES('n','Main',1)`);
  await db.run(sql`INSERT INTO layer(id,namespace_id,name,is_default) VALUES('l','n','Base',1)`);
  await db.run(
    sql`INSERT INTO partition(id,namespace_id,name,is_default) VALUES('p','n','Inbox',1)`,
  );
  await db.run(
    sql`INSERT INTO card(id,partition_id,layer_id,content) VALUES('c','p','l',${"kozane-image:/api/images/" + filename})`,
  );
  const staged = await stageCaptureInitialization(db, identity, catalog);
  expect(read).not.toHaveBeenCalled();
  expect(staged.owner).toEqual(await captureInitializationOwner(identity));
  expect(await rows(db, "SELECT state,manifest FROM local_asset_manifest")).toEqual([
    ["pending", JSON.stringify(catalog)],
  ]);
  await expect(
    prepareCaptureInitialization(db, identity, factory, catalog, async () => {
      throw Error("Missing image");
    }),
  ).rejects.toThrow("Missing image");
  const prepared = await prepareCaptureInitialization(db, identity, factory, catalog, read);
  expect(prepared.owner).not.toEqual(staged.owner);
  await expect(
    activateCaptureInitialization(db, identity, async () => new TextEncoder().encode("corrupt")),
  ).rejects.toThrow("bytes do not match");
  expect(
    await rows(db, "SELECT state FROM local_asset_manifest WHERE owner_kind='pending-work'"),
  ).toEqual([["pending"]]);
  await activateCaptureInitialization(db, identity, read);
  expect(
    await rows(db, "SELECT owner_kind,state FROM local_asset_manifest ORDER BY owner_kind"),
  ).toEqual([
    ["baseline", "retained"],
    ["pending-work", "released"],
  ]);
});
it("refuses reviewed release of initial staging protection and preserves the pending initialization", async () => {
  const db = await fixture();
  await stageCaptureInitialization(db, identity);
  await prepareCaptureInitialization(db, identity, factory);
  await db.run(
    sql`UPDATE local_asset_manifest SET state='released',released_at=1,release_reason='Cancelled' WHERE owner_kind='pending-work'`,
  );
  await expect(activateCaptureInitialization(db, identity)).rejects.toThrow(
    "staging protection is not active",
  );
  await expect(stageCaptureInitialization(db, identity)).rejects.toThrow(
    "staging protection is not active",
  );
  expect(await state(db)).toEqual([[0, "active", 1]]);
});
it("owns initialization identities before hashing, validation callbacks and activation can yield", async () => {
  const db = await fixture(),
    input = { ...identity };
  const pending = stageCaptureInitialization(db, input);
  input.epochId = "changed";
  const staged = await pending;
  expect(staged.request.targetEpoch).toBe(identity.epochId);
  const validating = { ...identity };
  await prepareCaptureInitialization(db, validating, async () => {
    validating.schemaId = "unsupported";
    validating.id = "changed";
    return factory();
  });
  const activating = { ...identity };
  const active = activateCaptureInitialization(db, activating);
  activating.epochId = "changed";
  await active;
  expect(await rows(db, "SELECT epoch_id FROM capture_epoch")).toEqual([[identity.epochId]]);
});
it("refuses temporary schema objects on staged retries, preparation and activation", async () => {
  const db = await fixture();
  await stageCaptureInitialization(db, identity);
  await prepareCaptureInitialization(db, identity, factory);
  for (const phase of ["stage", "prepare", "activate"]) {
    const wrapped = createDatabaseAdapter(new Proxy(db, {}), {
      read: (work) =>
        withReadTx(db, async (tx) => {
          await tx.values(sql`CREATE TEMP TABLE initialization_shadow(id INTEGER)`);
          return work(tx as unknown as DatabaseHandle);
        }),
      write: (work) =>
        withTx(db, async (tx) => {
          await tx.values(sql`CREATE TEMP TABLE initialization_shadow(id INTEGER)`);
          return work(tx);
        }),
    });
    const operation =
      phase === "stage"
        ? stageCaptureInitialization(wrapped, identity)
        : phase === "prepare"
          ? prepareCaptureInitialization(wrapped, identity, factory)
          : activateCaptureInitialization(wrapped, identity);
    await expect(operation).rejects.toThrow("temporary schema");
  }
  expect(await state(db)).toEqual([[0, "active", 1]]);
  await activateCaptureInitialization(db, identity);
});
