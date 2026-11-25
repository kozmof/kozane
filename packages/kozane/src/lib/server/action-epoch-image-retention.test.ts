import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import { openDb } from "../../db/client.js";
import { migrateNodeDatabase } from "../../db/tx.js";
import {
  installCapturePrototype,
  openCapturePrototype,
  type CaptureAssetPublisher,
} from "../../test-utils/action-capture.js";
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
  type DB as CoreDB,
  type Tx as CoreTx,
  type DatabaseHandle,
} from "../../../../core/src/database.js";
import { buildAssetManifest } from "../../../../core/src/actions/asset-manifest.js";
import { defineActionRegistry } from "../../../../core/src/actions/registry.js";
import { runActionGroup } from "../../../../core/src/actions/execution.js";
import { createActionBindings } from "../../../../core/src/actions/bindings.js";
import {
  reserveAssetManifestInTx,
  inspectAssetManifest,
  releaseAssetManifest,
  type AssetManifestOwner,
} from "../../db/api/asset-manifest.js";
import { retainImageManifestInTx } from "./image-manifest-retention.js";
import {
  collectUnusedImages,
  retryImageDeletions,
  imageDirectory,
  readImage,
} from "./image-assets.js";

const handles: Awaited<ReturnType<typeof openDb>>[] = [];
const roots: string[] = [];
const sourceOwner: AssetManifestOwner = { kind: "baseline", id: "source-epoch-baseline" };
async function open(path: string) {
  const handle = await openDb(path);
  handles.push(handle);
  return handle;
}
const factory = async () => (await open(":memory:")).db as unknown as CoreDB;
const local = (tx: CoreTx) => tx as unknown as Parameters<typeof reserveAssetManifestInTx>[0];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const handle of handles.splice(0)) handle.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
  const root = await fs.mkdtemp(join(tmpdir(), "kozane-epoch-images-"));
  roots.push(root);
  const path = `file:${join(root, "db.sqlite")}`,
    handle = await open(path),
    db = handle.db,
    core = db as unknown as CoreDB;
  await migrateNodeDatabase(db, { migrationsFolder: resolve("drizzle") });
  const names = [0, 1, 2].map(
    (n) => `.kozane/assets/images/00000000-0000-4000-8000-${String(n).padStart(12, "0")}.svg`,
  );
  await fs.mkdir(imageDirectory(root), { recursive: true });
  for (const [n, name] of names.entries())
    await fs.writeFile(join(root, name), `<svg><text>${n}</text></svg>`);
  const read = (name: string) => readImage(root, name.split("/").pop()!);
  const catalog = await buildAssetManifest(names, read);
  await db.run(sql`INSERT INTO namespace(id,name,is_default) VALUES('n','Main',1)`);
  await db.run(sql`INSERT INTO layer(id,namespace_id,name,is_default) VALUES('l','n','Base',1)`);
  await db.run(
    sql`INSERT INTO partition(id,namespace_id,name,is_default) VALUES('p','n','Inbox',1)`,
  );
  await db.run(
    sql`INSERT INTO card(id,partition_id,layer_id,content) VALUES('c','p','l',${"kozane-image:/api/images/" + names[0].split("/").pop()})`,
  );
  const publish: CaptureAssetPublisher = async (tx, publication) => {
    if (publication.kind !== "baseline") return;
    await reserveAssetManifestInTx(local(tx), sourceOwner, publication.manifest);
    await retainImageManifestInTx(local(tx), root, sourceOwner);
  };
  await installCapturePrototype(core, catalog, publish);
  const epoch = await db.values(sql`SELECT epoch_id,schema_id FROM capture_epoch`);
  const request: PrototypeEpochTransition = {
    id: "image-transition",
    sourceEpoch: String(epoch[0][0]),
    sourceSchema: String(epoch[0][1]),
    targetEpoch: "image-target",
    targetSchema: "next",
    batches: ["repair"],
  };
  await beginCaptureEpochTransition(core, request);
  await runCaptureMigrationBatch(core, request, 0, async (tx) => {
    await tx.run(
      sql`UPDATE card SET content=${"kozane-image:/api/images/" + names[1].split("/").pop()} WHERE id='c'`,
    );
  });
  const queue = async () => {
    await fs.mkdir(join(imageDirectory(root), ".pending-delete"), { recursive: true });
    for (const name of names) {
      await fs.writeFile(join(imageDirectory(root), ".pending-delete", name.split("/").pop()!), "");
      await fs.utimes(join(root, name), new Date(0), new Date(0));
    }
  };
  const cleanup = async () => {
    await collectUnusedImages(root, db, Date.now() + 3 * 86400000);
    await retryImageDeletions(root, db);
  };
  const prepare = (target: CoreDB = core, reader = read) =>
    prepareCaptureEpochBaseline(target, request, factory, catalog, reader);
  return { root, path, handle, db, core, names, catalog, read, request, queue, cleanup, prepare };
}
it("keeps candidate images protected after activation removes their last live reference while preserving the source owner", async () => {
  const f = await fixture(),
    source = (await inspectAssetManifest(f.db, sourceOwner)).record;
  const prepared = await f.prepare();
  await activateCaptureEpoch(f.core, f.request, f.read);
  const capture = await openCapturePrototype(f.core, f.catalog);
  const registry = defineActionRegistry<{ remove: unknown }, { db: CoreTx }>({
    contractVersion: 1,
    schemaVersions: [19],
    definitions: {
      remove: {
        eligibility: "syncable",
        prepare: (input) => input,
        replay: async (_input, { context }) => {
          await context.db.run(sql`DELETE FROM card WHERE id='c'`);
        },
      },
    },
  });
  await runActionGroup({
    db: f.core,
    registry,
    schemaVersion: 19,
    invocation: { id: "remove", kind: "remove", contractVersion: 1, input: {} },
    bindings: createActionBindings({
      mode: "record",
      allocateId: () => {
        throw Error("Unexpected ID");
      },
      now: () => {
        throw Error("Unexpected clock");
      },
    }),
    createContext: (_actions, db) => ({ db }),
    ...capture.hooks("remove"),
  });
  await f.queue();
  await f.cleanup();
  expect((await inspectAssetManifest(f.db, prepared.owner)).record.state).toBe("retained");
  expect((await inspectAssetManifest(f.db, sourceOwner)).record).toEqual(source);
  expect(await f.db.values(sql`SELECT 1 FROM card`)).toEqual([]);
  expect(new TextDecoder().decode(await f.read(f.names[0]))).toBe("<svg><text>0</text></svg>");
  expect(new TextDecoder().decode(await f.read(f.names[1]))).toBe("<svg><text>1</text></svg>");
  await expect(f.read(f.names[2])).rejects.toMatchObject({ code: "ENOENT" });
  await releaseAssetManifest(f.db, prepared.owner, "Transferred retained history");
  await f.cleanup();
  await expect(f.read(f.names[1])).rejects.toMatchObject({ code: "ENOENT" });
  expect((await inspectAssetManifest(f.db, sourceOwner)).record).toEqual(source);
  await capture.verify();
});
it("makes the pending pin visible to another connection before any host image read", async () => {
  const f = await fixture(),
    second = await open(f.path);
  let first = true;
  const prepared = await f.prepare(f.core, async (name) => {
    if (first) {
      first = false;
      const pending = await second.db.values(
        sql`SELECT state FROM local_asset_manifest WHERE owner_id<>${sourceOwner.id}`,
      );
      expect(pending[0][0]).toBe("pending");
      await f.queue();
      await collectUnusedImages(f.root, second.db, Date.now() + 3 * 86400000);
      await retryImageDeletions(f.root, second.db);
    }
    return f.read(name);
  });
  expect(first).toBe(false);
  expect((await inspectAssetManifest(second.db, prepared.owner)).record.state).toBe("retained");
  await expect(f.read(f.names[2])).rejects.toMatchObject({ code: "ENOENT" });
});
it("keeps the pending pin across candidate commit failure and restart without repeating repair", async () => {
  const f = await fixture();
  let writes = 0;
  const wrapped = createDatabaseAdapter(new Proxy(f.core, {}), {
    read: (work) => withReadTx(f.core, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(f.core, async (tx) => {
        const result = await work(tx);
        if (++writes === 2) throw Error("Candidate commit failed");
        return result;
      }),
  });
  await expect(f.prepare(wrapped)).rejects.toThrow("Candidate commit failed");
  const pending = await f.db.values(
    sql`SELECT owner_id,state FROM local_asset_manifest WHERE owner_id<>${sourceOwner.id}`,
  );
  expect(pending[0][1]).toBe("pending");
  f.handle.close();
  const reopened = await open(f.path),
    core = reopened.db as unknown as CoreDB;
  const repair = vi.fn(async () => {});
  expect((await runCaptureMigrationBatch(core, f.request, 0, repair)).changed).toBe(false);
  expect(repair).not.toHaveBeenCalled();
  const prepared = await f.prepare(core);
  expect(prepared.owner.id).toBe(pending[0][0]);
  await activateCaptureEpoch(core, f.request, f.read);
  expect((await inspectAssetManifest(reopened.db, prepared.owner)).record.state).toBe("retained");
  await (await openCapturePrototype(core)).verify();
});
it("preserves retained protection and the candidate after failed activation commit and completes after restart", async () => {
  const f = await fixture(),
    prepared = await f.prepare();
  const owner = (await inspectAssetManifest(f.db, prepared.owner)).record;
  const wrapped = createDatabaseAdapter(new Proxy(f.core, {}), {
    read: (work) => withReadTx(f.core, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(f.core, async (tx) => {
        await work(tx);
        throw Error("Activation commit failed");
      }),
  });
  await expect(activateCaptureEpoch(wrapped, f.request, f.read)).rejects.toThrow(
    "Activation commit failed",
  );
  expect((await inspectAssetManifest(f.db, prepared.owner)).record).toEqual(owner);
  expect((await f.db.values(sql`SELECT epoch_id FROM capture_epoch`))[0][0]).toBe(
    f.request.sourceEpoch,
  );
  f.handle.close();
  const reopened = await open(f.path),
    core = reopened.db as unknown as CoreDB;
  await activateCaptureEpoch(core, f.request, f.read);
  expect((await inspectAssetManifest(reopened.db, prepared.owner)).record).toEqual(owner);
  await (await openCapturePrototype(core)).verify();
});
it.each(["candidate", "activation"] as const)(
  "serializes %s publication with image cleanup and owner release",
  async (phase) => {
    const f = await fixture(),
      second = await open(f.path);
    if (phase === "activation") await f.prepare();
    const entered = Promise.withResolvers<void>(),
      proceed = Promise.withResolvers<void>();
    let writes = 0;
    const wrapped = createDatabaseAdapter(new Proxy(f.core, {}), {
      read: (work) => withReadTx(f.core, (tx) => work(tx as unknown as DatabaseHandle)),
      write: (work) =>
        withTx(f.core, async (tx) => {
          const result = await work(tx);
          if (++writes === (phase === "candidate" ? 2 : 1)) {
            entered.resolve();
            await proceed.promise;
          }
          return result;
        }),
    });
    const pending =
      phase === "candidate" ? f.prepare(wrapped) : activateCaptureEpoch(wrapped, f.request, f.read);
    const settled = pending.then(
      (result) => ({ result, error: null }),
      (error) => ({ result: null, error }),
    );
    try {
      await Promise.race([
        entered.promise,
        settled.then((value) => {
          throw value.error ?? Error("Publication finished early");
        }),
      ]);
      await second.db.values(sql`PRAGMA busy_timeout=1`);
      const rows = await second.db.values(
        sql`SELECT owner_id,state FROM local_asset_manifest WHERE owner_id<>${sourceOwner.id}`,
      );
      expect(rows[0][1]).toBe(phase === "candidate" ? "pending" : "retained");
      const owner: AssetManifestOwner = { kind: "baseline", id: String(rows[0][0]) };
      await expect(releaseAssetManifest(second.db, owner, "Concurrent release")).rejects.toThrow();
      await expect(collectUnusedImages(f.root, second.db)).rejects.toThrow();
      proceed.resolve();
      expect((await settled).error).toBeNull();
      expect((await inspectAssetManifest(second.db, owner)).record.state).toBe("retained");
      expect((await inspectAssetManifest(second.db, sourceOwner)).record.state).toBe("retained");
    } finally {
      proceed.resolve();
      await settled;
    }
  },
);
it("rechecks released protection and readable archived bytes without recreating missing live files", async () => {
  const f = await fixture();
  await fs.mkdir(join(imageDirectory(f.root), ".retained"));
  await fs.rename(
    join(f.root, f.names[1]),
    join(imageDirectory(f.root), ".retained", f.names[1].split("/").pop()!),
  );
  const prepared = await f.prepare();
  await releaseAssetManifest(f.db, prepared.owner, "Reviewed release");
  await expect(activateCaptureEpoch(f.core, f.request, f.read)).rejects.toThrow(
    "protection is not active",
  );
  expect((await f.db.values(sql`SELECT state FROM capture_epoch_transition`))[0][0]).toBe("active");
  await expect(fs.lstat(join(f.root, f.names[1]))).rejects.toMatchObject({ code: "ENOENT" });
  expect(new TextDecoder().decode(await f.read(f.names[1]))).toBe("<svg><text>1</text></svg>");
  expect((await inspectAssetManifest(f.db, sourceOwner)).record.state).toBe("retained");
});
