import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import { openDb } from "../../db/client.js";
import { withTx } from "../../db/database.js";
import type { DB } from "../../../../core/src/database.js";
import { migrations } from "../../../../core/src/generated/migrations.js";
import { captureLocalRecoverySnapshot } from "../../../../core/src/actions/local-recovery.js";
import { localRecoveryAssetManifest } from "../../../../core/src/actions/local-recovery-assets.js";
import { localImageUploadTable } from "../../db/schema.js";
import {
  reserveAssetManifest,
  releaseAssetManifest,
  inspectAssetManifest,
} from "../../db/api/asset-manifest.js";
import {
  storeImage,
  imageDirectory,
  collectUnusedImages,
  retryImageDeletions,
} from "./image-assets.js";
import { retainImageManifest } from "./image-manifest-retention.js";
import { abandonImageUpload } from "./image-upload-recovery.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each([false, true])(
  "protects checkpoint image requirements through recovery-owner verification (missing=%s)",
  async (missing) => {
    const root = await mkdtemp(join(tmpdir(), "kozane-local-recovery-assets-"));
    roots.push(root);
    const db = await createTestDB(join(root, "db.sqlite"));
    const uploads: (typeof localImageUploadTable.$inferSelect)[] = [];
    for (const n of [1, 2, 3, 4]) {
      const url = await storeImage(
        root,
        db,
        "image.svg",
        new TextEncoder().encode(`<svg><text>${n}</text></svg>`),
      );
      const filename = url.split("/").pop()!;
      uploads.push(
        (await db.select().from(localImageUploadTable)).find((row) => row.filename === filename)!,
      );
    }
    for (const row of uploads.slice(2))
      await db.run(
        sql`UPDATE local_image_upload SET state='completed',completed_at=1 WHERE filename=${row.filename}`,
      );
    const manifest = (indices: number[]) => ({
      version: 1,
      entries: indices.map((index) => ({
        name: `.kozane/assets/images/${uploads[index].filename}`,
        byteLength: uploads[index].byteLength,
        sha256: uploads[index].sha256,
      })),
    });
    const transfer = { kind: "transfer" as const, id: "incoming" };
    const recovery = { kind: "recovery" as const, id: "checkpoint" };
    await reserveAssetManifest(db, transfer, manifest([1]));
    await rm(join(imageDirectory(root), uploads[3].filename));
    const snapshot = await captureLocalRecoverySnapshot(
      db as unknown as DB,
      {
        workspaceId: "workspace",
        deviceId: "device",
        epochId: "epoch",
        checkpointId: "checkpoint",
        schemaId: migrations.at(-1)!.id,
      },
      async () => ({ baselineId: "baseline", effectSetIds: [] }),
    );
    // The selected shared checkpoint also requires the third image. The inactive fourth is not required.
    const required = localRecoveryAssetManifest(snapshot, [manifest([2])]);
    expect(required.entries.map((entry) => entry.name).sort()).toEqual(
      manifest([0, 1, 2])
        .entries.map((entry) => entry.name)
        .sort(),
    );
    await reserveAssetManifest(db, recovery, required);
    for (const row of uploads.slice(0, 2))
      await abandonImageUpload(db, row.filename, "Retained by checkpoint", true);
    await releaseAssetManifest(db, transfer, "Transferred to checkpoint");
    const queue = join(imageDirectory(root), ".pending-delete");
    await mkdir(queue, { recursive: true });
    for (const row of uploads.slice(0, 3)) {
      await writeFile(join(queue, row.filename), "");
      await utimes(join(imageDirectory(root), row.filename), new Date(0), new Date(0));
    }
    if (missing) await rm(join(imageDirectory(root), uploads[0].filename));
    const cleanup = async () => {
      await collectUnusedImages(root, db);
      await retryImageDeletions(root, db);
    };
    await cleanup();
    expect(
      uploads.slice(1, 3).every((row) => existsSync(join(imageDirectory(root), row.filename))),
    ).toBe(true);
    if (missing) {
      await expect(retainImageManifest(db, root, recovery)).rejects.toThrow("absent");
      expect((await inspectAssetManifest(db, recovery)).record.state).toBe("pending");
      await cleanup();
      expect(
        uploads.slice(1, 3).every((row) => existsSync(join(imageDirectory(root), row.filename))),
      ).toBe(true);
    } else {
      expect((await retainImageManifest(db, root, recovery)).record.state).toBe("retained");
      await cleanup();
      expect(await readFile(join(imageDirectory(root), uploads[0].filename), "utf8")).toContain(
        "<text>1</text>",
      );
      await releaseAssetManifest(db, recovery, "Checkpoint retired");
      await cleanup();
      expect(
        uploads.every(
          (row) =>
            !existsSync(join(imageDirectory(root), row.filename)) &&
            !existsSync(join(imageDirectory(root), ".retained", row.filename)),
        ),
      ).toBe(true);
    }
  },
);

it("keeps local rows and shared-history selection at one checkpoint while another connection commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "kozane-local-recovery-checkpoint-"));
  roots.push(root);
  const path = join(root, "db.sqlite");
  const db = await createTestDB(path);
  const writer = await openDb(`file:${path}`);
  try {
    await db.run(
      sql`CREATE TABLE recovery_checkpoint(singleton INTEGER PRIMARY KEY,baseline TEXT,effects TEXT)`,
    );
    await db.run(
      sql`INSERT INTO recovery_checkpoint VALUES(1,'baseline-before','["origin-before"]')`,
    );
    await db.run(
      sql`INSERT INTO taskspace_local VALUES('absent','local/before','workspace_relative',9007199254740993)`,
    );
    const keys = {
      workspaceId: "workspace",
      deviceId: "device",
      epochId: "epoch",
      checkpointId: "checkpoint",
      schemaId: migrations.at(-1)!.id,
    };
    let reads = 0;
    const snapshot = await captureLocalRecoverySnapshot(db as unknown as DB, keys, async (tx) => {
      const [selection] = await tx.values(sql`SELECT baseline,effects FROM recovery_checkpoint`);
      // WAL permits this independent transaction to commit while the read snapshot stays open.
      await withTx(writer.db, async (write) => {
        await write.run(
          sql`UPDATE recovery_checkpoint SET baseline='baseline-after',effects='["origin-after"]'`,
        );
        await write.run(
          sql`UPDATE taskspace_local SET path='local/after',last_seen_at=9007199254740995`,
        );
      });
      reads++;
      return { baselineId: String(selection[0]), effectSetIds: JSON.parse(String(selection[1])) };
    });
    expect(reads).toBe(1);
    expect(snapshot.selection).toEqual({
      baselineId: "baseline-before",
      effectSetIds: ["origin-before"],
    });
    expect(
      snapshot.tables.find((table) => table.name === "taskspace_local")!.rows[0],
    ).toMatchObject({
      path: ["text", "local/before"],
      last_seen_at: ["integer", "9007199254740993"],
    });
    const later = await captureLocalRecoverySnapshot(
      db as unknown as DB,
      { ...keys, checkpointId: "later" },
      async (tx) => {
        const [selection] = await tx.values(sql`SELECT baseline,effects FROM recovery_checkpoint`);
        return { baselineId: String(selection[0]), effectSetIds: JSON.parse(String(selection[1])) };
      },
    );
    expect(later.selection).toEqual({
      baselineId: "baseline-after",
      effectSetIds: ["origin-after"],
    });
    expect(later.tables.find((table) => table.name === "taskspace_local")!.rows[0]).toMatchObject({
      path: ["text", "local/after"],
      last_seen_at: ["integer", "9007199254740995"],
    });
    expect(snapshot.identity.checkpointId).toBe("checkpoint");
  } finally {
    writer.close();
  }
});
