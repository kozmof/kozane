import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import { withTx } from "../database.js";
import { localAssetManifestTable, localImageUploadTable, namespaceTable } from "../schema.js";
import {
  reserveAssetManifest,
  reserveAssetManifestInTx,
  releaseAssetManifest,
  releaseAssetManifestInTx,
  confirmVerifiedAssetManifestInTx,
  inspectAssetManifest,
  retainedImageNames,
  type AssetManifestOwner,
} from "./asset-manifest.js";
import { installCapturePrototype, capturedTables } from "../../test-utils/action-capture.js";
import type { DB as CoreDB } from "../../../../core/src/database.js";
import { withMigration } from "../../../../core/src/database.js";
import { migrations } from "../../../../core/src/generated/migrations.js";
import { applyMigrations } from "../../../../core/src/migrations/apply.js";
const filename = "00000000-0000-4000-8000-000000000001.svg";
const image = { name: `.kozane/assets/images/${filename}`, byteLength: 3, sha256: "a".repeat(64) };
const manifest = { version: 1, entries: [image] };
const owner: AssetManifestOwner = { kind: "baseline", id: "epoch-1" };

it.each(["baseline", "effect-set", "pending-work", "transfer", "recovery"] as const)(
  "retains immutable %s reservations and explicit release decisions",
  async (kind) => {
    const db = await createTestDB();
    const key = { ...owner, kind };
    const pending = await reserveAssetManifest(db, key, manifest);
    expect(pending.record).toMatchObject({
      ownerKind: kind,
      ownerId: "epoch-1",
      state: "pending",
      verifiedAt: null,
    });
    expect((await reserveAssetManifest(db, key, manifest)).changed).toBe(false);
    expect((await inspectAssetManifest(db, key)).record).toEqual(pending.record);
    expect(await withTx(db, retainedImageNames)).toEqual(new Set([filename]));
    const released = await releaseAssetManifest(db, key, "Owner expired");
    expect(released.record).toMatchObject({
      ...pending.record,
      state: "released",
      releasedAt: expect.any(Date),
      releaseReason: "Owner expired",
    });
    expect(await withTx(db, retainedImageNames)).toEqual(new Set());
    expect((await releaseAssetManifest(db, key, "Owner expired")).changed).toBe(false);
    expect((await inspectAssetManifest(db, key)).record).toEqual(released.record);
    await expect(releaseAssetManifest(db, key, "Different reason")).rejects.toThrow(
      "another reason",
    );
    await expect(reserveAssetManifest(db, key, manifest)).rejects.toThrow("cannot be reused");
  },
);

it("copies caller-owned metadata and refuses replacing an owner's manifest", async () => {
  const db = await createTestDB();
  const input = { kind: "baseline" as const, id: "original" };
  const value = { version: 1, entries: [{ ...image }] };
  const pending = reserveAssetManifest(db, input, value);
  input.id = "changed";
  value.entries[0].sha256 = "b".repeat(64);
  expect((await pending).record.ownerId).toBe("original");
  expect((await inspectAssetManifest(db, { ...owner, id: "original" })).manifest).toEqual(manifest);
  await expect(
    reserveAssetManifest(db, { ...owner, id: "original" }, { version: 1, entries: [] }),
  ).rejects.toThrow("different asset manifest");
});

it("requires every owner to release its own protection", async () => {
  const db = await createTestDB();
  await reserveAssetManifest(db, owner, manifest);
  const other = { kind: "recovery" as const, id: "checkpoint" };
  await reserveAssetManifest(db, other, manifest);
  await releaseAssetManifest(db, owner, "Baseline replaced");
  expect(await withTx(db, retainedImageNames)).toEqual(new Set([filename]));
  await releaseAssetManifest(db, other, "Checkpoint expired");
  expect(await withTx(db, retainedImageNames)).toEqual(new Set());
});

it.each(["active", "released", "upload"] as const)(
  "refuses collisions with %s identity records",
  async (kind) => {
    const db = await createTestDB();
    if (kind === "upload")
      await db.insert(localImageUploadTable).values({
        filename,
        byteLength: image.byteLength,
        sha256: image.sha256,
        state: "abandoned",
        createdAt: new Date(1000),
        abandonedAt: new Date(2000),
        abandonReason: "Reviewed",
      });
    else {
      await reserveAssetManifest(db, owner, manifest);
      if (kind === "released") await releaseAssetManifest(db, owner, "Expired");
    }
    for (const changed of [
      { ...image, sha256: "b".repeat(64) },
      { ...image, byteLength: 4 },
    ])
      await expect(
        reserveAssetManifest(
          db,
          { kind: "transfer", id: "incoming" },
          { version: 1, entries: [changed] },
        ),
      ).rejects.toThrow("Conflicting asset bytes");
    expect(
      (await db.select().from(localAssetManifestTable)).some((row) => row.ownerId === "incoming"),
    ).toBe(false);
  },
);

it.each([false, true])(
  "retains staging protection after atomic owner publication fails (commit=%s)",
  async (commit) => {
    const db = await createTestDB();
    await db.insert(namespaceTable).values({ id: "n", name: "Original" });
    const pending = await reserveAssetManifest(db, owner, manifest);
    if (commit) {
      await db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
      await db.run(
        sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      await db.run(
        sql`CREATE TRIGGER reject_manifest AFTER UPDATE ON local_asset_manifest WHEN NEW.state='retained' BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
      );
    } else
      await db.run(
        sql`CREATE TRIGGER reject_manifest BEFORE UPDATE ON local_asset_manifest WHEN NEW.state='retained' BEGIN SELECT RAISE(ABORT,'publication refused'); END`,
      );
    await expect(
      withTx(db, async (tx) => {
        await tx.update(namespaceTable).set({ name: "Uncommitted owner" });
        await confirmVerifiedAssetManifestInTx(tx, owner, pending.record.manifest);
      }),
    ).rejects.toThrow();
    expect((await inspectAssetManifest(db, owner)).record).toEqual(pending.record);
    expect((await db.select().from(namespaceTable))[0].name).toBe("Original");
    expect(await withTx(db, retainedImageNames)).toEqual(new Set([filename]));
    await db.run(sql`DROP TRIGGER reject_manifest`);
    const retained = await withTx(db, (tx) =>
      confirmVerifiedAssetManifestInTx(tx, owner, pending.record.manifest),
    );
    expect(retained.record.state).toBe("retained");
    expect(
      (
        await withTx(db, (tx) =>
          confirmVerifiedAssetManifestInTx(tx, owner, pending.record.manifest),
        )
      ).changed,
    ).toBe(false);
  },
);

it("transfers protection atomically and rolls back both owner records on failure", async () => {
  const db = await createTestDB();
  const pending = await reserveAssetManifest(db, owner, manifest);
  const target = { kind: "effect-set" as const, id: "accepted" };
  await expect(
    withTx(db, async (tx) => {
      await reserveAssetManifestInTx(tx, target, manifest);
      await releaseAssetManifestInTx(tx, owner, "Transferred");
      throw new Error("Owner commit failed");
    }),
  ).rejects.toThrow("Owner commit failed");
  expect(await db.select().from(localAssetManifestTable)).toEqual([pending.record]);
  await withTx(db, async (tx) => {
    await reserveAssetManifestInTx(tx, target, manifest);
    await releaseAssetManifestInTx(tx, owner, "Transferred");
  });
  expect(await withTx(db, retainedImageNames)).toEqual(new Set([filename]));
});

it("keeps pending, retained and released local owners through shared replacement", async () => {
  const db = await createTestDB();
  await reserveAssetManifest(db, owner, manifest);
  const retained = { kind: "effect-set" as const, id: "history" };
  const row = await reserveAssetManifest(db, retained, manifest);
  await withTx(db, (tx) => confirmVerifiedAssetManifestInTx(tx, retained, row.record.manifest));
  const released = { kind: "transfer" as const, id: "expired" };
  await reserveAssetManifest(db, released, manifest);
  await releaseAssetManifest(db, released, "Transferred");
  const before = await db.select().from(localAssetManifestTable);
  const capture = await installCapturePrototype(db as unknown as CoreDB);
  expect(capturedTables).toHaveLength(12);
  expect(capturedTables.some((table) => table.name === "local_asset_manifest")).toBe(false);
  await capture.restore(async () => (await createTestDB()) as unknown as CoreDB, []);
  expect(await db.select().from(localAssetManifestTable)).toEqual(before);
});

it.each(["", " ", "\0", "x".repeat(1001)])(
  "refuses invalid release reasons %# without releasing protection",
  async (reason) => {
    const db = await createTestDB();
    const pending = await reserveAssetManifest(db, owner, manifest);
    await expect(releaseAssetManifest(db, owner, reason)).rejects.toThrow("Release reason");
    expect((await inspectAssetManifest(db, owner)).record).toEqual(pending.record);
  },
);

it.each([false, true])(
  "migration 26 preserves earlier local evidence and rolls back cleanly (rollback=%s)",
  async (fail) => {
    const db = (await createTestDB()) as unknown as CoreDB;
    const migration = migrations.find((row) => row.tag === "0026_local_asset_manifest")!;
    await withMigration(db, async () => [
      { sql: "DROP TABLE local_asset_manifest", args: [] },
      { sql: "DELETE FROM __drizzle_migrations WHERE created_at>=?", args: [migration.when] },
      {
        sql: "INSERT INTO local_image_upload(filename,byte_length,sha256,state,created_at,error) VALUES(?,?,?,'pending',9007199254740993,'Original failure')",
        args: [filename, 3, image.sha256],
      },
    ]);
    const before = Array.from(
      (
        await db.values(sql`SELECT filename,CAST(created_at AS TEXT),error FROM local_image_upload`)
      )[0],
    );
    if (fail) {
      await db.run(
        sql.raw(
          `CREATE TRIGGER reject_upgrade BEFORE INSERT ON __drizzle_migrations WHEN NEW.created_at=${migration.when} BEGIN SELECT RAISE(ABORT,'upgrade refused'); END`,
        ),
      );
      await expect(applyMigrations(db)).rejects.toThrow();
      await expect(db.select().from(localAssetManifestTable)).rejects.toThrow();
      await db.run(sql`DROP TRIGGER reject_upgrade`);
    }
    expect((await applyMigrations(db)).appliedIds).toEqual([migration.id]);
    expect(
      Array.from(
        (
          await db.values(
            sql`SELECT filename,CAST(created_at AS TEXT),error FROM local_image_upload`,
          )
        )[0],
      ),
    ).toEqual(before);
  },
);
