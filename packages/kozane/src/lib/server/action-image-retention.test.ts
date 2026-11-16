import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import { openDb } from "../../db/client.js";
import {
  installCapturePrototype,
  openCapturePrototype,
  captureApplicationRows,
  type CaptureAssetPublisher,
} from "../../test-utils/action-capture.js";
import type { DB as CoreDB, Tx as CoreTx } from "../../../../core/src/database.js";
import type { Tx } from "../../db/database.js";
import {
  buildAssetManifest,
  selectAssetManifest,
  parseAssetManifest,
} from "../../../../core/src/actions/asset-manifest.js";
import { defineActionRegistry } from "../../../../core/src/actions/registry.js";
import { runActionGroup } from "../../../../core/src/actions/execution.js";
import { createActionBindings } from "../../../../core/src/actions/bindings.js";
import {
  cardTable,
  namespaceTable,
  layerTable,
  partitionTable,
  localAssetManifestTable,
  localImageUploadTable,
} from "../../db/schema.js";
import {
  reserveAssetManifest,
  reserveAssetManifestInTx,
  readAssetManifest,
  releaseAssetManifest,
  releaseAssetManifestInTx,
  inspectAssetManifest,
  type AssetManifestOwner,
} from "../../db/api/asset-manifest.js";
import { createServiceContext } from "../../services/context.js";
import { updateInTx, removeInTx } from "../../services/cards.js";
import { retainImageManifestInTx } from "./image-manifest-retention.js";
import {
  imageDirectory,
  storeImage,
  readImage,
  collectUnusedImages,
  retryImageDeletions,
} from "./image-assets.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const baselineOwner: AssetManifestOwner = { kind: "baseline", id: "prototype-baseline" };
const baselineStage: AssetManifestOwner = { kind: "pending-work", id: "baseline-staging" };
const stage = (id: string): AssetManifestOwner => ({ kind: "pending-work", id: `staging:${id}` });
const effectOwner = (id: string): AssetManifestOwner => ({ kind: "effect-set", id });
// The fixture's source adapter and the application's package adapter share the runtime transaction.
const local = (tx: CoreTx) => tx as unknown as Tx;
type Input = { sequence: string[]; extra?: string; remove?: boolean };

async function fixture(uploads = false, beforeEffectPublication?: () => Promise<void>) {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
  const root = await fs.mkdtemp(join(tmpdir(), "kozane-captured-image-retention-"));
  roots.push(root);
  const db = await createTestDB(join(root, "db.sqlite"));
  const core = db as unknown as CoreDB;
  await db.insert(namespaceTable).values({ id: "n", name: "Main", isDefault: true });
  await db.insert(layerTable).values({ id: "l", namespaceId: "n", name: "Base", isDefault: true });
  await db
    .insert(partitionTable)
    .values({ id: "p", namespaceId: "n", name: "Inbox", isDefault: true });
  const bodies = [1, 2, 3, 4].map((n) => new TextEncoder().encode(`<svg><text>${n}</text></svg>`));
  const names: string[] = [];
  for (const [index, bytes] of bodies.entries()) {
    const filename = uploads
      ? (await storeImage(root, db, "image.svg", bytes)).split("/").pop()!
      : `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}.svg`;
    names.push(`.kozane/assets/images/${filename}`);
  }
  const refs = names.map((name) => "kozane-image:/api/images/" + name.split("/").pop());
  const catalog = await buildAssetManifest(names, async (name) => bodies[names.indexOf(name)]);
  await reserveAssetManifest(db, baselineStage, selectAssetManifest(catalog, [names[0]]));
  await reserveAssetManifest(db, stage("action"), catalog);
  if (!uploads) {
    await fs.mkdir(imageDirectory(root), { recursive: true });
    for (const [index, name] of names.entries())
      await fs.writeFile(join(root, name), bodies[index]);
  }
  await db.insert(cardTable).values({
    id: "c",
    partitionId: "p",
    layerId: "l",
    content: refs[0],
    createdAt: new Date(1000),
    updatedAt: new Date(1000),
  });
  // Initial publication predates capture, as it does in a populated workspace.
  if (uploads)
    await db.run(
      sql`UPDATE local_image_upload SET state='completed',completed_at=1 WHERE filename=${names[0].split("/").pop()!}`,
    );
  const publish: CaptureAssetPublisher = async (tx, publication) => {
    const owner = publication.kind === "baseline" ? baselineOwner : effectOwner(publication.id);
    const source = publication.kind === "baseline" ? baselineStage : stage(publication.id);
    const pending = await readAssetManifest(local(tx), source);
    if (pending.record.state === "released") throw new Error("Staging owner was already released");
    const covered = selectAssetManifest(
      pending.manifest,
      publication.manifest.entries.map((entry) => entry.name),
    );
    if (JSON.stringify(covered) !== JSON.stringify(publication.manifest))
      throw new Error("Staging bytes differ");
    await reserveAssetManifestInTx(local(tx), owner, publication.manifest);
    await retainImageManifestInTx(local(tx), root, owner);
    if (publication.kind === "effect-set") await beforeEffectPublication?.();
    await releaseAssetManifestInTx(local(tx), source, "Published captured image requirements");
  };
  const registry = defineActionRegistry<{ replace: Input }, { db: Tx }>({
    contractVersion: 1,
    schemaVersions: [26],
    definitions: {
      replace: {
        eligibility: "syncable",
        prepare: (input) => input as Input,
        replay: async (input, { context }) => {
          for (const content of input.sequence)
            await updateInTx(context.db, createServiceContext(), "n", "c", { content });
          if (input.remove)
            await removeInTx(context.db, createServiceContext(), "n", { cardIds: ["c"] });
        },
      },
    },
  });
  const install = () => installCapturePrototype(core, catalog, publish);
  const run = (
    capture: Awaited<ReturnType<typeof install>>,
    input: Input = { sequence: refs.slice(1, 3), extra: refs[3], remove: true },
  ) =>
    runActionGroup({
      db: core,
      registry,
      schemaVersion: 26,
      invocation: { id: "action", kind: "replace", contractVersion: 1, input },
      bindings: createActionBindings({
        mode: "record",
        allocateId: () => {
          throw new Error("Unexpected ID");
        },
        now: () => 100,
      }),
      createContext: (_frame, tx) => ({ db: local(tx) }),
      ...capture.hooks("action"),
    });
  const queue = async () => {
    const directory = join(imageDirectory(root), ".pending-delete");
    await fs.mkdir(directory, { recursive: true });
    for (const name of names) {
      await fs.writeFile(join(directory, name.split("/").pop()!), "");
      await fs.utimes(join(root, name), new Date(0), new Date(0));
    }
  };
  const cleanup = async () => {
    await collectUnusedImages(root, db);
    await retryImageDeletions(root, db);
  };
  const state = async () => ({
    rows: await captureApplicationRows(core),
    owners: await db.select().from(localAssetManifestTable),
    uploads: await db.select().from(localImageUploadTable),
    objects: await core.values(sql`SELECT name,sql FROM sqlite_schema ORDER BY name`),
  });
  return { root, db, core, names, refs, catalog, install, run, queue, cleanup, state, publish };
}

it("publishes baseline ownership and installs capture guards in one transaction", async () => {
  const f = await fixture();
  const capture = await f.install();
  const owner = await inspectAssetManifest(f.db, baselineOwner);
  expect(owner.record.state).toBe("retained");
  expect(owner.manifest).toEqual(capture.baselineManifest);
  expect((await inspectAssetManifest(f.db, baselineStage)).record.state).toBe("released");
  expect((await inspectAssetManifest(f.db, stage("action"))).record.state).toBe("pending");
  const before = await f.state();
  await expect(f.db.run(sql`DELETE FROM card`)).rejects.toThrow();
  expect(await f.state()).toEqual(before);
});

it.each(["schema", "verification", "commit"] as const)(
  "preserves baseline staging after %s failure without partially installing capture",
  async (failure) => {
    const f = await fixture();
    if (failure === "schema") await f.db.run(sql`CREATE TABLE capture_effect(existing TEXT)`);
    if (failure === "verification") await fs.rm(join(f.root, f.names[0]));
    if (failure === "commit")
      await rejectCommit(f.core, "local_asset_manifest", "NEW.state='retained'");
    const before = await f.state();
    await expect(f.install()).rejects.toThrow();
    expect(await f.state()).toEqual(before);
    expect((await inspectAssetManifest(f.db, baselineStage)).record.state).toBe("pending");
    expect(await f.db.select().from(localAssetManifestTable)).toHaveLength(2);
  },
);

it("retains full captured image requirements after the last card disappears and history is deselected", async () => {
  const f = await fixture();
  const capture = await f.install();
  await f.queue();
  await f.cleanup();
  expect(f.names.every((name) => existsSync(join(f.root, name)))).toBe(true);
  await f.run(capture);
  expect(await f.db.select().from(cardTable)).toEqual([]);
  const [run] = await capture.runs();
  const owner = await inspectAssetManifest(f.db, effectOwner("action"));
  expect(owner.record.state).toBe("retained");
  expect(owner.manifest).toEqual(parseAssetManifest(JSON.parse(run.assets!)));
  expect(owner.manifest).toEqual(f.catalog);
  expect((await inspectAssetManifest(f.db, stage("action"))).record.state).toBe("released");
  await f.cleanup();
  expect(f.names.every((name) => existsSync(join(f.root, name)))).toBe(true);
  const localBefore = await f.db.select().from(localAssetManifestTable);
  const reopened = await openCapturePrototype(f.core);
  await reopened.restore(
    async () => (await createTestDB()) as unknown as CoreDB,
    [],
    async (name) => readImage(f.root, name.split("/").pop()!),
  );
  expect(await reopened.selection()).toEqual([]);
  expect(await reopened.runs()).toEqual([run]);
  expect(await f.db.select().from(localAssetManifestTable)).toEqual(localBefore);
  await f.cleanup();
  expect(f.names.every((name) => existsSync(join(f.root, name)))).toBe(true);
  await reopened.verify();
});

it.each(["statement", "verification", "commit"] as const)(
  "rolls back history, references and protection transfer after %s failure",
  async (failure) => {
    const f = await fixture();
    const capture = await f.install();
    if (failure === "statement")
      await f.db.run(
        sql`CREATE TRIGGER reject_publication BEFORE UPDATE ON local_asset_manifest WHEN NEW.state='released' AND NEW.owner_id='staging:action' BEGIN SELECT RAISE(ABORT,'release refused'); END`,
      );
    if (failure === "verification") await fs.writeFile(join(f.root, f.names[1]), "Changed bytes");
    if (failure === "commit")
      await rejectCommit(
        f.core,
        "local_asset_manifest",
        "NEW.state='released' AND NEW.owner_id='staging:action'",
      );
    const before = await f.state();
    await expect(f.run(capture)).rejects.toThrow();
    expect(await f.state()).toEqual(before);
    expect(await capture.runs()).toEqual([]);
    expect(await capture.selection()).toEqual([]);
    expect(await capture.effects("action")).toEqual([]);
    expect((await inspectAssetManifest(f.db, stage("action"))).record.state).toBe("pending");
    await f.queue();
    await f.cleanup();
    expect(f.names.every((name) => existsSync(join(f.root, name)))).toBe(true);
    await capture.verify();
  },
);

it("publishes invocation-only requirements for an action with no row effects", async () => {
  const f = await fixture();
  const capture = await f.install();
  await f.run(capture, { sequence: [], extra: f.refs[3] });
  expect(await capture.effects("action")).toEqual([]);
  expect((await inspectAssetManifest(f.db, effectOwner("action"))).manifest).toEqual(
    selectAssetManifest(f.catalog, [f.names[3]]),
  );
  expect((await inspectAssetManifest(f.db, baselineOwner)).manifest).toEqual(
    capture.baselineManifest,
  );
});

it("refuses a released staging owner even when its catalog and local bytes still match", async () => {
  const f = await fixture();
  const capture = await f.install();
  await releaseAssetManifest(f.db, stage("action"), "Staged work cancelled");
  const before = await f.state();
  await expect(f.run(capture)).rejects.toThrow("Staging owner was already released");
  expect(await f.state()).toEqual(before);
  expect(await capture.runs()).toEqual([]);
  expect(await capture.selection()).toEqual([]);
});

it.each([false, true])(
  "serializes cleanup from another connection across capture publication (fail=%s)",
  async (fail) => {
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const f = await fixture(false, async () => {
      entered.resolve();
      await proceed.promise;
      if (fail) throw new Error("Interrupted publication");
    });
    const capture = await f.install();
    await f.queue();
    const other = await openDb(`file:${join(f.root, "db.sqlite")}`);
    await other.db.values(sql`PRAGMA busy_timeout=1`);
    const running = f.run(capture);
    void running.catch(() => {});
    try {
      await entered.promise;
      await expect(collectUnusedImages(f.root, other.db)).rejects.toThrow();
      expect(f.names.every((name) => existsSync(join(f.root, name)))).toBe(true);
    } finally {
      proceed.resolve();
      if (fail) await expect(running).rejects.toThrow("Interrupted publication");
      else await running;
      other.close();
    }
    await f.cleanup();
    expect(f.names.every((name) => existsSync(join(f.root, name)))).toBe(true);
    expect((await inspectAssetManifest(f.db, stage("action"))).record.state).toBe(
      fail ? "pending" : "released",
    );
    if (fail) expect(await capture.runs()).toEqual([]);
    else
      expect((await inspectAssetManifest(f.db, effectOwner("action"))).record.state).toBe(
        "retained",
      );
  },
);

it.each([false, true])(
  "commits upload completion, full effects and manifest ownership together (fail=%s)",
  async (fail) => {
    const f = await fixture(true);
    const capture = await f.install();
    if (fail)
      await rejectCommit(
        f.core,
        "local_asset_manifest",
        "NEW.state='released' AND NEW.owner_id='staging:action'",
      );
    const before = await f.state();
    const action = () => f.run(capture, { sequence: [f.refs[1]], remove: true });
    if (fail) {
      await expect(action()).rejects.toThrow();
      expect(await f.state()).toEqual(before);
      await f.db.run(sql`DROP TRIGGER reject_commit`);
    }
    await action();
    const uploads = await f.db.select().from(localImageUploadTable);
    expect(
      uploads
        .filter((row) => row.state === "completed")
        .map((row) => row.filename)
        .sort(),
    ).toEqual(
      f.names
        .slice(0, 2)
        .map((name) => name.split("/").pop()!)
        .sort(),
    );
    expect(await f.db.select().from(cardTable)).toEqual([]);
    expect((await inspectAssetManifest(f.db, effectOwner("action"))).manifest).toEqual(
      selectAssetManifest(f.catalog, f.names.slice(0, 2)),
    );
    await f.queue();
    await f.cleanup();
    expect(f.names.slice(0, 2).every((name) => existsSync(join(f.root, name)))).toBe(true);
  },
);

async function rejectCommit(db: CoreDB, table: string, condition: string) {
  await db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
  await db.run(
    sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
  );
  await db.run(
    sql.raw(
      `CREATE TRIGGER reject_commit AFTER UPDATE ON ${table} WHEN ${condition} BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
    ),
  );
}
