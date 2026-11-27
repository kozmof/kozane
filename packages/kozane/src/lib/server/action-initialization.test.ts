import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import { openDb } from "../../db/client.js";
import { migrateNodeDatabase } from "../../db/tx.js";
import {
  stageCaptureInitialization,
  prepareCaptureInitialization,
  activateCaptureInitialization,
  repairCaptureInitialization,
  inspectCaptureInitialization,
} from "../../test-utils/action-initialization.js";
import { openCapturePrototype } from "../../test-utils/action-capture.js";
import {
  withReadTx,
  withTx,
  createDatabaseAdapter,
  type DB,
  type DatabaseHandle,
} from "../../../../core/src/database.js";
import { migrations } from "../../../../core/src/generated/migrations.js";
import { buildAssetManifest } from "../../../../core/src/actions/asset-manifest.js";
import { inspectAssetManifest, releaseAssetManifest } from "../../db/api/asset-manifest.js";
import { collectUnusedImages, imageDirectory, readImage } from "./image-assets.js";

vi.setConfig({ testTimeout: 30_000 });
const roots: string[] = [],
  handles: Awaited<ReturnType<typeof openDb>>[] = [];
const identity = { id: "initial-enable", epochId: "first-active", schemaId: migrations.at(-1)!.id };
const repairing = { ...identity, repair: "inventories" as const };
async function open(path: string) {
  const handle = await openDb(path);
  handles.push(handle);
  return handle;
}
const factory = async () => (await open(":memory:")).db as unknown as DB;
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const handle of handles.splice(0)) handle.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
  const root = await fs.mkdtemp(join(tmpdir(), "kozane-initial-capture-"));
  roots.push(root);
  const path = `file:${join(root, "db.sqlite")}`,
    handle = await open(path),
    db = handle.db,
    core = db as unknown as DB;
  await migrateNodeDatabase(db, { migrationsFolder: resolve("drizzle") });
  const filename = "00000000-0000-4000-8000-000000000001.svg",
    name = ".kozane/assets/images/" + filename,
    data = new TextEncoder().encode("<svg><text>initial</text></svg>");
  await fs.mkdir(imageDirectory(root), { recursive: true });
  await fs.writeFile(join(root, name), data);
  const read = (name: string) => readImage(root, name.split("/").pop()!);
  const catalog = await buildAssetManifest([name], read);
  await db.run(sql`INSERT INTO namespace(id,name,is_default) VALUES('n','Main',1)`);
  await db.run(sql`INSERT INTO layer(id,namespace_id,name,is_default) VALUES('l','n','Base',1)`);
  await db.run(
    sql`INSERT INTO partition(id,namespace_id,name,is_default) VALUES('p','n','Inbox',1)`,
  );
  await db.run(
    sql`INSERT INTO card(id,partition_id,layer_id,content) VALUES('seeded','p','l',${"kozane-image:/api/images/" + filename})`,
  );
  await db.run(
    sql`INSERT INTO taskspace_local VALUES('absent','local/retained','workspace_relative',9007199254740993)`,
  );
  return { root, path, handle, db, core, name, data, read, catalog };
}
async function seedInitialRepair(db: DB) {
  await db.run(sql`INSERT INTO inventory(id,namespace_id,name) VALUES('i','n','Box')`);
  const trigger = (
    await db.values(sql`SELECT sql FROM sqlite_schema WHERE name='card_inventory_pair_update'`)
  )[0][0];
  await db.run(sql`DROP TRIGGER card_inventory_pair_update`);
  await db.run(sql`UPDATE card SET inventory_id='i' WHERE id='seeded'`);
  await db.run(sql.raw(String(trigger)));
}
it.each(["preparation", "activation"] as const)(
  "inspects one consistent snapshot while another connection commits %s",
  async (phase) => {
    const f = await fixture();
    await stageCaptureInitialization(f.core, identity, f.catalog);
    if (phase === "activation")
      await prepareCaptureInitialization(f.core, identity, factory, f.catalog, f.read);
    const other = await open(f.path);
    const write = vi.fn(async () => {
      throw Error("Inspection must not write");
    });
    const wrapped = createDatabaseAdapter(new Proxy(f.core, {}), {
      read: (work) =>
        withReadTx(f.core, async (tx) => {
          await tx.values(sql`SELECT candidate FROM capture_epoch_transition`);
          if (phase === "preparation")
            await prepareCaptureInitialization(
              other.db as unknown as DB,
              identity,
              factory,
              f.catalog,
              f.read,
            );
          else await activateCaptureInitialization(other.db as unknown as DB, identity, f.read);
          return work(tx as unknown as DatabaseHandle);
        }),
      write,
    });
    const captured = await inspectCaptureInitialization(wrapped, identity);
    expect(captured.phase).toBe(
      phase === "preparation" ? "validation-pending" : "activation-pending",
    );
    expect(captured.stagingProtection).toBe("pending");
    const current = await inspectCaptureInitialization(f.core, identity);
    expect(current.phase).toBe(phase === "preparation" ? "activation-pending" : "active");
    expect(current.stagingProtection).toBe(phase === "preparation" ? "pending" : "released");
    expect(write).not.toHaveBeenCalled();
  },
);

it("inspects a prepared initialization without reading missing image bytes or activating writes", async () => {
  const f = await fixture();
  await stageCaptureInitialization(f.core, identity, f.catalog);
  const prepared = await prepareCaptureInitialization(f.core, identity, factory, f.catalog, f.read);
  await fs.unlink(join(f.root, f.name));
  const current = await inspectCaptureInitialization(f.core, identity);
  expect(current.phase).toBe("activation-pending");
  expect(current.candidate?.owner).toEqual(prepared.owner);
  expect(current.candidate?.protection).toBe("retained");
  await expect(activateCaptureInitialization(f.core, identity, f.read)).rejects.toThrow();
  expect((await inspectCaptureInitialization(f.core, identity)).phase).toBe("activation-pending");
  await expect(f.db.run(sql`INSERT INTO scope VALUES('raw','unstamped')`)).rejects.toThrow();
});

it("resumes initial repair across restarts without repeating a committed batch", async () => {
  const f = await fixture();
  await seedInitialRepair(f.core);
  const staged = await stageCaptureInitialization(f.core, repairing, f.catalog);
  const original = (await f.db.values(sql`SELECT rows FROM capture_baseline`))[0][0];
  f.handle.close();
  const started = await open(f.path);
  const core = started.db as unknown as DB;
  const validation = vi.fn(factory);
  await expect(
    prepareCaptureInitialization(core, repairing, validation, f.catalog, f.read),
  ).rejects.toThrow("batches are incomplete");
  expect(validation).not.toHaveBeenCalled();
  expect(await repairCaptureInitialization(core, repairing)).toEqual({ changed: true });
  expect((await started.db.values(sql`SELECT rows FROM capture_baseline`))[0][0]).toBe(original);
  started.close();
  const repaired = await open(f.path);
  await repaired.db.run(
    sql`CREATE TRIGGER refuse_repair_reexecution BEFORE UPDATE OF inventory_id,inventory_slot ON card BEGIN SELECT RAISE(ABORT,'Repair repeated'); END`,
  );
  expect(await repairCaptureInitialization(repaired.db as unknown as DB, repairing)).toEqual({
    changed: false,
  });
  const prepared = await prepareCaptureInitialization(
    repaired.db as unknown as DB,
    repairing,
    factory,
    f.catalog,
    f.read,
  );
  repaired.close();
  const ready = await open(f.path);
  await expect(ready.db.run(sql`INSERT INTO scope VALUES('raw','unstamped')`)).rejects.toThrow();
  await activateCaptureInitialization(ready.db as unknown as DB, repairing, f.read);
  ready.close();
  const active = await open(f.path);
  expect(await repairCaptureInitialization(active.db as unknown as DB, repairing)).toEqual({
    changed: false,
  });
  expect(
    (await active.db.values(sql`SELECT next_batch,state FROM capture_epoch_transition`))[0][0],
  ).toBe(1);
  expect((await active.db.values(sql`SELECT count(*) FROM capture_migration_history`))[0][0]).toBe(
    1,
  );
  expect(
    (
      await active.db.values(sql`SELECT inventory_id,inventory_slot FROM card WHERE id='seeded'`)
    )[0][0],
  ).toBeNull();
  expect(
    (await active.db.values(sql`SELECT CAST(last_seen_at AS TEXT) FROM taskspace_local`))[0][0],
  ).toBe("9007199254740993");
  expect((await inspectAssetManifest(active.db, staged.owner)).record.state).toBe("released");
  expect((await inspectAssetManifest(active.db, prepared.owner)).record.state).toBe("retained");
  await (await openCapturePrototype(active.db as unknown as DB)).verify();
});
it("resumes an initial repair whose data and progress commit failed", async () => {
  const f = await fixture();
  await seedInitialRepair(f.core);
  const staged = await stageCaptureInitialization(f.core, repairing, f.catalog);
  const wrapped = createDatabaseAdapter(new Proxy(f.core, {}), {
    read: (work) => withReadTx(f.core, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(f.core, async (tx) => {
        await work(tx);
        throw Error("Initial repair commit failed");
      }),
  });
  await expect(repairCaptureInitialization(wrapped, repairing)).rejects.toThrow(
    "Initial repair commit failed",
  );
  f.handle.close();
  const resumed = await open(f.path);
  const core = resumed.db as unknown as DB;
  expect(
    (await resumed.db.values(sql`SELECT next_batch FROM capture_epoch_transition`))[0][0],
  ).toBe(0);
  expect((await resumed.db.values(sql`SELECT count(*) FROM capture_migration_history`))[0][0]).toBe(
    0,
  );
  expect(
    (await resumed.db.values(sql`SELECT inventory_id FROM card WHERE id='seeded'`))[0][0],
  ).toBe("i");
  expect((await inspectAssetManifest(resumed.db, staged.owner)).record.state).toBe("pending");
  await expect(resumed.db.run(sql`INSERT INTO scope VALUES('raw','unstamped')`)).rejects.toThrow();
  expect((await stageCaptureInitialization(core, repairing)).changed).toBe(false);
  expect(await repairCaptureInitialization(core, repairing)).toEqual({ changed: true });
  await prepareCaptureInitialization(core, repairing, factory, f.catalog, f.read);
  await activateCaptureInitialization(core, repairing, f.read);
  await (await openCapturePrototype(core)).verify();
});
it("resumes a staged initial baseline across restarts while preserving seeded rows and local metadata", async () => {
  const f = await fixture(),
    staged = await stageCaptureInitialization(f.core, identity, f.catalog);
  f.handle.close();
  const resumed = await open(f.path),
    core = resumed.db as unknown as DB;
  await expect(resumed.db.run(sql`INSERT INTO scope VALUES('raw','unstamped')`)).rejects.toThrow();
  expect((await stageCaptureInitialization(core, identity)).changed).toBe(false);
  const prepared = await prepareCaptureInitialization(core, identity, factory, f.catalog, f.read);
  resumed.close();
  const ready = await open(f.path);
  await expect(ready.db.run(sql`INSERT INTO scope VALUES('raw','unstamped')`)).rejects.toThrow();
  await activateCaptureInitialization(ready.db as unknown as DB, identity, f.read);
  ready.close();
  const active = await open(f.path);
  await (await openCapturePrototype(active.db as unknown as DB)).verify();
  expect((await inspectAssetManifest(active.db, staged.owner)).record.state).toBe("released");
  expect((await inspectAssetManifest(active.db, prepared.owner)).record.state).toBe("retained");
  expect(
    (await active.db.values(sql`SELECT CAST(last_seen_at AS TEXT) FROM taskspace_local`))[0][0],
  ).toBe("9007199254740993");
  expect((await active.db.values(sql`SELECT id FROM card`))[0][0]).toBe("seeded");
});
it("keeps initial and candidate pins after failed validation and resumes without recapturing rows", async () => {
  const f = await fixture(),
    staged = await stageCaptureInitialization(f.core, identity, f.catalog);
  const original = (await f.db.values(sql`SELECT rows FROM capture_baseline`))[0][0];
  await expect(
    prepareCaptureInitialization(
      f.core,
      identity,
      async () => {
        throw Error("Validation interrupted");
      },
      f.catalog,
      f.read,
    ),
  ).rejects.toThrow("Validation interrupted");
  const pending = await f.db.values(
    sql`SELECT owner_id,state FROM local_asset_manifest WHERE owner_kind='baseline'`,
  );
  expect(pending[0][1]).toBe("pending");
  f.handle.close();
  const resumed = await open(f.path),
    core = resumed.db as unknown as DB;
  expect((await inspectAssetManifest(resumed.db, staged.owner)).record.state).toBe("pending");
  expect((await resumed.db.values(sql`SELECT rows FROM capture_baseline`))[0][0]).toBe(original);
  const prepared = await prepareCaptureInitialization(core, identity, factory, f.catalog, f.read);
  expect(prepared.owner.id).toBe(pending[0][0]);
  await activateCaptureInitialization(core, identity, f.read);
});
it("rolls back changed activation metadata after staging completion and resumes the retained candidate after restart", async () => {
  const f = await fixture();
  await seedInitialRepair(f.core);
  const staged = await stageCaptureInitialization(f.core, repairing, f.catalog);
  await repairCaptureInitialization(f.core, repairing);
  await f.db.run(sql`CREATE TABLE activation_fault(enabled INTEGER)`);
  await f.db.run(sql`INSERT INTO activation_fault VALUES(1)`);
  await f.db.run(
    sql`CREATE TRIGGER corrupt_initial_baseline AFTER UPDATE OF state ON local_asset_manifest WHEN NEW.owner_kind='pending-work' AND NEW.state='released' AND (SELECT enabled FROM activation_fault)=1 BEGIN UPDATE capture_baseline SET rows='[]'; END`,
  );
  const prepared = await prepareCaptureInitialization(
    f.core,
    repairing,
    factory,
    f.catalog,
    f.read,
  );
  await expect(activateCaptureInitialization(f.core, repairing, f.read)).rejects.toThrow(
    "baseline or selection changed",
  );
  expect((await inspectAssetManifest(f.db, staged.owner)).record.state).toBe("pending");
  expect((await inspectAssetManifest(f.db, prepared.owner)).record.state).toBe("retained");
  f.handle.close();
  const resumed = await open(f.path);
  const core = resumed.db as unknown as DB;
  expect((await resumed.db.values(sql`SELECT epoch_id FROM capture_epoch`))[0][0]).toBe("initial");
  expect((await resumed.db.values(sql`SELECT state FROM capture_epoch_transition`))[0][0]).toBe(
    "active",
  );
  expect((await resumed.db.values(sql`SELECT count(*) FROM capture_epoch_archive`))[0][0]).toBe(0);
  await expect(resumed.db.run(sql`INSERT INTO scope VALUES('raw','unstamped')`)).rejects.toThrow();
  expect(await repairCaptureInitialization(core, repairing)).toEqual({ changed: false });
  await resumed.db.run(sql`UPDATE activation_fault SET enabled=0`);
  await activateCaptureInitialization(core, repairing, f.read);
  expect((await resumed.db.values(sql`SELECT count(*) FROM capture_migration_history`))[0][0]).toBe(
    1,
  );
  expect((await inspectAssetManifest(resumed.db, staged.owner)).record.state).toBe("released");
  expect((await inspectAssetManifest(resumed.db, prepared.owner)).record.state).toBe("retained");
  expect(new TextDecoder().decode(await f.read(f.name))).toBe(new TextDecoder().decode(f.data));
  await (await openCapturePrototype(core)).verify();
});

it("preserves blocking and image protection after failed activation commit and completes after restart", async () => {
  const f = await fixture(),
    staged = await stageCaptureInitialization(f.core, identity, f.catalog);
  const prepared = await prepareCaptureInitialization(f.core, identity, factory, f.catalog, f.read);
  const wrapped = createDatabaseAdapter(new Proxy(f.core, {}), {
    read: (work) => withReadTx(f.core, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(f.core, async (tx) => {
        await work(tx);
        throw Error("Activation commit failed");
      }),
  });
  await expect(activateCaptureInitialization(wrapped, identity, f.read)).rejects.toThrow(
    "Activation commit failed",
  );
  expect((await inspectAssetManifest(f.db, staged.owner)).record.state).toBe("pending");
  expect((await inspectAssetManifest(f.db, prepared.owner)).record.state).toBe("retained");
  f.handle.close();
  const resumed = await open(f.path),
    core = resumed.db as unknown as DB;
  await expect(resumed.db.run(sql`INSERT INTO scope VALUES('raw','unstamped')`)).rejects.toThrow();
  await activateCaptureInitialization(core, identity, f.read);
  expect((await inspectAssetManifest(resumed.db, staged.owner)).record.state).toBe("released");
  await (await openCapturePrototype(core)).verify();
});
it("refuses initial candidate publication after another connection releases its staging pin during validation", async () => {
  const f = await fixture();
  const staged = await stageCaptureInitialization(f.core, identity, f.catalog);
  const other = await open(f.path);
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const pending = prepareCaptureInitialization(
    f.core,
    identity,
    async () => {
      entered.resolve();
      await proceed.promise;
      return factory();
    },
    f.catalog,
    f.read,
  );
  const settled = pending.then(
    (result) => ({ result, error: null }),
    (error) => ({ result: null, error }),
  );
  try {
    await Promise.race([
      entered.promise,
      settled.then(({ error }) => {
        throw error ?? Error("Preparation ended early");
      }),
    ]);
    await releaseAssetManifest(other.db, staged.owner, "Cancelled while validating");
    proceed.resolve();
    await expect(pending).rejects.toThrow("staging protection is not active");
    expect((await inspectAssetManifest(f.db, staged.owner)).record.state).toBe("released");
    expect(
      (
        await f.db.values(sql`SELECT state FROM local_asset_manifest WHERE owner_kind='baseline'`)
      )[0][0],
    ).toBe("pending");
    expect(
      (await f.db.values(sql`SELECT candidate FROM capture_epoch_transition`))[0][0],
    ).toBeNull();
    expect(new TextDecoder().decode(await f.read(f.name))).toBe(new TextDecoder().decode(f.data));
    await expect(f.db.run(sql`INSERT INTO scope VALUES('raw','unstamped')`)).rejects.toThrow();
  } finally {
    proceed.resolve();
    await settled;
  }
});

it.each(["stage", "repair", "preparation", "activation"] as const)(
  "serializes %s with another connection's application writes and cleanup",
  async (phase) => {
    const f = await fixture(),
      other = await open(f.path);
    const requested = phase === "repair" ? repairing : identity;
    if (phase === "repair" || phase === "preparation")
      await stageCaptureInitialization(f.core, requested, f.catalog);
    if (phase === "activation") {
      await stageCaptureInitialization(f.core, identity, f.catalog);
      await prepareCaptureInitialization(f.core, identity, factory, f.catalog, f.read);
    }
    const entered = Promise.withResolvers<void>(),
      proceed = Promise.withResolvers<void>();
    let writes = 0;
    const wrapped = createDatabaseAdapter(new Proxy(f.core, {}), {
      read: (work) => withReadTx(f.core, (tx) => work(tx as unknown as DatabaseHandle)),
      write: (work) =>
        withTx(f.core, async (tx) => {
          const result = await work(tx);
          if (phase !== "preparation" || ++writes === 2) {
            entered.resolve();
            await proceed.promise;
          }
          return result;
        }),
    });
    const pending =
      phase === "stage"
        ? stageCaptureInitialization(wrapped, identity, f.catalog)
        : phase === "repair"
          ? repairCaptureInitialization(wrapped, requested)
          : phase === "preparation"
            ? prepareCaptureInitialization(wrapped, requested, factory, f.catalog, f.read)
            : activateCaptureInitialization(wrapped, identity, f.read);
    const settled = pending.then(
      (result) => ({ result, error: null }),
      (error) => ({ result: null, error }),
    );
    try {
      await Promise.race([
        entered.promise,
        settled.then((value) => {
          throw value.error ?? Error("Initialization ended early");
        }),
      ]);
      await other.db.values(sql`PRAGMA busy_timeout=1`);
      await expect(
        other.db.run(sql`INSERT INTO scope VALUES('raw','unstamped')`),
      ).rejects.toThrow();
      if (phase !== "stage") {
        const pin = await other.db.values(
          sql`SELECT owner_id,state FROM local_asset_manifest WHERE owner_kind='pending-work'`,
        );
        expect(pin[0][1]).toBe("pending");
        await expect(
          releaseAssetManifest(
            other.db,
            { kind: "pending-work", id: String(pin[0][0]) },
            "Concurrent release",
          ),
        ).rejects.toThrow();
      }
      await expect(
        collectUnusedImages(f.root, other.db, Date.now() + 3 * 86400000),
      ).rejects.toThrow();
      proceed.resolve();
      expect((await settled).error).toBeNull();
      await collectUnusedImages(f.root, other.db, Date.now() + 3 * 86400000);
      expect(new TextDecoder().decode(await f.read(f.name))).toBe(new TextDecoder().decode(f.data));
    } finally {
      proceed.resolve();
      await settled;
    }
  },
);
